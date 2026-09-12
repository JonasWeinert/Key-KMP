use fastembed::{
    InitOptionsUserDefined, Pooling, QuantizationMode, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};
use frankensearch_core::{
    Cx, EMBEDDING_INPUT_CONTRACT_SCHEMA_V1, EMBEDDING_PRODUCER_ATTESTATION_SCHEMA_V1,
    EMBEDDING_SPACE_IDENTITY_SCHEMA_V1, Embedder, EmbeddingArtifactIdentityV1,
    EmbeddingIdentityBundleV1, EmbeddingInputContractV1, EmbeddingProducerAttestationV1,
    EmbeddingSpaceIdentityV1, EmbeddingSpaceKindV1, GoldenVectorCertificateV1, ModelCategory,
    QuantizationFormat, SearchError, SearchFuture, SearchResult, VECTOR_STORAGE_IDENTITY_SCHEMA_V1,
    VectorStorageIdentityV1,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const MODEL_DIRECTORY_NAME: &str = "snowflake-arctic-embed-xs-q";
pub const MODEL_ID: &str = "snowflake-arctic-embed-xs-q-384";
pub const MODEL_REVISION: &str = "d8c86521100d3556476a063fc2342036d45c106f";
pub const DIMENSION: usize = 384;
pub const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

const MODEL_FILE: &str = "onnx/model_quantized.onnx";
const TOKENIZER_FILE: &str = "tokenizer.json";
const CONFIG_FILE: &str = "config.json";
const SPECIAL_TOKENS_FILE: &str = "special_tokens_map.json";
const TOKENIZER_CONFIG_FILE: &str = "tokenizer_config.json";
const MAX_LENGTH: usize = 512;
const INTRA_THREADS: usize = 4;

pub fn model_fingerprint(model_dir: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut h = Sha256::new();
    h.update(b"arctic-xs-cls-normalized-512-v1");
    for name in [
        MODEL_FILE,
        TOKENIZER_FILE,
        CONFIG_FILE,
        SPECIAL_TOKENS_FILE,
        TOKENIZER_CONFIG_FILE,
    ] {
        h.update(name.as_bytes());
        let mut f = fs::File::open(model_dir.join(name)).map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 65536];
        loop {
            let count = f.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            h.update(&buffer[..count]);
        }
    }
    Ok(format!("{:x}", h.finalize()))
}

pub struct ArcticEmbedder {
    model: Mutex<TextEmbedding>,
    query_cache: Mutex<Option<(String, Vec<f32>)>>,
    identity: EmbeddingIdentityBundleV1,
}

impl ArcticEmbedder {
    pub fn load(model_dir: &Path) -> Result<Self, String> {
        let model_bytes = read(model_dir, MODEL_FILE)?;
        let tokenizer_bytes = read(model_dir, TOKENIZER_FILE)?;
        let config_bytes = read(model_dir, CONFIG_FILE)?;
        let special_tokens_bytes = read(model_dir, SPECIAL_TOKENS_FILE)?;
        let tokenizer_config_bytes = read(model_dir, TOKENIZER_CONFIG_FILE)?;

        let artifacts = vec![
            artifact("weights-int8", &model_bytes),
            artifact("tokenizer", &tokenizer_bytes),
            artifact("config", &config_bytes),
            artifact("special-tokens", &special_tokens_bytes),
            artifact("tokenizer-config", &tokenizer_config_bytes),
        ];
        let tokenizer_hash = hash_bytes(&tokenizer_bytes);
        let config_hash = hash_bytes(&config_bytes);
        let manifest_hash = artifact_manifest_hash(&artifacts);
        let tokenizer_files = TokenizerFiles {
            tokenizer_file: tokenizer_bytes,
            config_file: config_bytes,
            special_tokens_map_file: special_tokens_bytes,
            tokenizer_config_file: tokenizer_config_bytes,
        };
        let user_model = UserDefinedEmbeddingModel::new(model_bytes, tokenizer_files)
            .with_pooling(Pooling::Cls)
            .with_quantization(QuantizationMode::Dynamic);
        let options = InitOptionsUserDefined::new()
            .with_max_length(MAX_LENGTH)
            .with_intra_threads(INTRA_THREADS);
        let mut model = TextEmbedding::try_new_from_user_defined(user_model, options)
            .map_err(|error| format!("failed to load Arctic XS ONNX model: {error}"))?;

        let golden_texts = ["Key semantic search conformance probe."];
        let mut golden_vectors = model
            .embed(golden_texts, None)
            .map_err(|error| format!("failed Arctic XS conformance inference: {error}"))?;
        for vector in &mut golden_vectors {
            normalize(vector);
        }
        let golden = GoldenVectorCertificateV1::from_exact_f32(&golden_texts, &golden_vectors)
            .map_err(|error| error.to_string())?;
        let identity = build_identity(
            artifacts,
            manifest_hash,
            tokenizer_hash,
            config_hash,
            golden,
        )?;

        Ok(Self {
            model: Mutex::new(model),
            query_cache: Mutex::new(None),
            identity,
        })
    }

    pub fn embed_texts(&self, texts: &[&str]) -> SearchResult<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut model = self
            .model
            .lock()
            .map_err(|_| SearchError::EmbeddingFailed {
                model: MODEL_ID.to_owned(),
                source: "Arctic XS inference lock was poisoned".into(),
            })?;
        let mut vectors =
            model
                .embed(texts, None)
                .map_err(|error| SearchError::EmbeddingFailed {
                    model: MODEL_ID.to_owned(),
                    source: error.to_string().into(),
                })?;
        for vector in &mut vectors {
            if vector.len() != DIMENSION {
                return Err(SearchError::EmbeddingFailed {
                    model: MODEL_ID.to_owned(),
                    source: format!(
                        "Arctic XS returned dimension {}, expected {DIMENSION}",
                        vector.len()
                    )
                    .into(),
                });
            }
            normalize(vector);
        }
        Ok(vectors)
    }

    pub fn identity_bundle(&self) -> &EmbeddingIdentityBundleV1 {
        &self.identity
    }
}

impl Embedder for ArcticEmbedder {
    fn embed<'a>(&'a self, _cx: &'a Cx, text: &'a str) -> SearchFuture<'a, Vec<f32>> {
        Box::pin(async move {
            if let Ok(cache) = self.query_cache.lock() {
                if let Some((query, vector)) = cache.as_ref() {
                    if query == text {
                        return Ok(vector.clone());
                    }
                }
            }
            let input = format!("{QUERY_PREFIX}{text}");
            let mut vectors = self.embed_texts(&[&input])?;
            let vector = vectors.pop().unwrap_or_else(|| vec![0.0; DIMENSION]);
            if let Ok(mut cache) = self.query_cache.lock() {
                *cache = Some((text.to_owned(), vector.clone()));
            }
            Ok(vector)
        })
    }

    fn embed_batch<'a>(
        &'a self,
        _cx: &'a Cx,
        texts: &'a [&'a str],
    ) -> SearchFuture<'a, Vec<Vec<f32>>> {
        Box::pin(async move { self.embed_texts(texts) })
    }

    fn identity(&self) -> SearchResult<&EmbeddingIdentityBundleV1> {
        Ok(&self.identity)
    }

    fn dimension(&self) -> usize {
        DIMENSION
    }

    fn id(&self) -> &str {
        MODEL_ID
    }

    fn model_name(&self) -> &str {
        "Snowflake Arctic Embed XS (quantized)"
    }

    fn is_semantic(&self) -> bool {
        true
    }

    fn category(&self) -> ModelCategory {
        ModelCategory::TransformerEmbedder
    }
}

#[derive(Default)]
struct DecodedVectors {
    values: std::collections::HashMap<String, Vec<f32>>,
    order: std::collections::VecDeque<String>,
}
pub struct PrecomputedEmbedder {
    decoded: Mutex<DecodedVectors>,
    reader: key_library::ArtifactReader,
    hash: String,
    version: String,
    identity: EmbeddingIdentityBundleV1,
}

impl PrecomputedEmbedder {
    pub fn new(
        reader: key_library::ArtifactReader,
        hash: String,
        version: String,
        identity: EmbeddingIdentityBundleV1,
    ) -> Self {
        Self {
            decoded: Mutex::new(DecodedVectors::default()),
            reader,
            hash,
            version,
            identity,
        }
    }
}

impl Embedder for PrecomputedEmbedder {
    fn embed<'a>(&'a self, _cx: &'a Cx, text: &'a str) -> SearchFuture<'a, Vec<f32>> {
        Box::pin(async move {
            let key = key_library::content_hash(text.as_bytes());
            if let Some(vector) = self
                .decoded
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values
                .get(&key)
                .cloned()
            {
                return Ok(vector);
            }
            let vector = self
                .reader
                .get::<Vec<f32>>(&self.hash, "embedding", &self.version, &key)
                .map_err(|e| SearchError::EmbeddingFailed {
                    model: MODEL_ID.into(),
                    source: e.into(),
                })?
                .ok_or_else(|| SearchError::EmbeddingFailed {
                    model: MODEL_ID.into(),
                    source: "precomputed Arctic XS vector was missing".into(),
                })?;
            if vector.len() != DIMENSION || vector.iter().any(|v| !v.is_finite()) {
                return Err(SearchError::EmbeddingFailed {
                    model: MODEL_ID.into(),
                    source: "Invalid cached embedding vector".into(),
                });
            }
            let mut cache = self.decoded.lock().unwrap_or_else(|e| e.into_inner());
            if !cache.values.contains_key(&key) {
                if cache.values.len() >= 2048 {
                    if let Some(old) = cache.order.pop_front() {
                        cache.values.remove(&old);
                    }
                }
                cache.order.push_back(key.clone());
                cache.values.insert(key, vector.clone());
            }
            Ok(vector)
        })
    }

    fn identity(&self) -> SearchResult<&EmbeddingIdentityBundleV1> {
        Ok(&self.identity)
    }

    fn dimension(&self) -> usize {
        DIMENSION
    }

    fn id(&self) -> &str {
        MODEL_ID
    }

    fn model_name(&self) -> &str {
        "Snowflake Arctic Embed XS (precomputed quantized vectors)"
    }

    fn is_semantic(&self) -> bool {
        true
    }

    fn category(&self) -> ModelCategory {
        ModelCategory::TransformerEmbedder
    }
}

pub fn default_model_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("KEY_SEMANTIC_MODEL_DIR") {
        return validate_model_dir(PathBuf::from(path));
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(macos_dir) = executable.parent()
        && let Some(contents_dir) = macos_dir.parent()
    {
        let bundled = contents_dir
            .join("Resources")
            .join("models")
            .join(MODEL_DIRECTORY_NAME);
        if bundled.join(MODEL_FILE).is_file() {
            return Ok(bundled);
        }
    }
    validate_model_dir(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(MODEL_DIRECTORY_NAME),
    )
}

fn validate_model_dir(path: PathBuf) -> Result<PathBuf, String> {
    if path.join(MODEL_FILE).is_file() {
        Ok(path)
    } else {
        Err(format!(
            "Arctic XS model resources were not found in {}",
            path.display()
        ))
    }
}

fn read(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let path = root.join(relative);
    fs::read(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))
}

fn artifact(role: &str, bytes: &[u8]) -> EmbeddingArtifactIdentityV1 {
    EmbeddingArtifactIdentityV1 {
        role: role.to_owned(),
        sha256: hash_bytes(bytes),
        size: bytes.len() as u64,
    }
}

fn artifact_manifest_hash(artifacts: &[EmbeddingArtifactIdentityV1]) -> String {
    let mut ordered = artifacts.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.role.cmp(&right.role));
    let mut hasher = Sha256::new();
    hasher.update(b"key.arctic-xs-artifacts.v1");
    hasher.update(MODEL_REVISION.as_bytes());
    for artifact in ordered {
        hasher.update(artifact.role.as_bytes());
        hasher.update(artifact.sha256.as_bytes());
        hasher.update(artifact.size.to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn build_identity(
    artifacts: Vec<EmbeddingArtifactIdentityV1>,
    manifest_hash: String,
    tokenizer_hash: String,
    config_hash: String,
    golden_vectors: GoldenVectorCertificateV1,
) -> Result<EmbeddingIdentityBundleV1, String> {
    let input = EmbeddingInputContractV1 {
        schema_version: EMBEDDING_INPUT_CONTRACT_SCHEMA_V1,
        canonicalization: "utf8-preserved-whitespace-v1".to_owned(),
        content_selection: "pdf-sentence-with-one-neighbor-each-side-v1".to_owned(),
        chunking: "one-target-sentence-plus-one-leading-and-trailing-sentence-v1".to_owned(),
        query_instruction: QUERY_PREFIX.trim_end().to_owned(),
        document_instruction: String::new(),
        doc_id_semantics: "sha256-document-hash-page-block-sentence-v1".to_owned(),
    };
    let space = EmbeddingSpaceIdentityV1 {
        schema_version: EMBEDDING_SPACE_IDENTITY_SCHEMA_V1,
        logical_model_id: MODEL_ID.to_owned(),
        immutable_revision: MODEL_REVISION.to_owned(),
        kind: EmbeddingSpaceKindV1::Semantic,
        artifact_manifest_fingerprint: manifest_hash.clone(),
        artifacts,
        tokenizer_fingerprint: tokenizer_hash.clone(),
        vocabulary_fingerprint: tokenizer_hash,
        model_config_fingerprint: config_hash,
        model_preprocessing: "fastembed-5.17.2-bert-tokenizer-v1".to_owned(),
        sequence_policy: "max-512-truncate-longest-pad-batch-v1".to_owned(),
        query_instruction: QUERY_PREFIX.trim_end().to_owned(),
        document_instruction: String::new(),
        pooling: "cls-token-v1".to_owned(),
        output_normalization: "l2-f32-v1".to_owned(),
        dimension: DIMENSION as u32,
        input_contract_fingerprint: input.fingerprint(),
        hash_control: None,
        projection: None,
    };
    let producer = EmbeddingProducerAttestationV1 {
        schema_version: EMBEDDING_PRODUCER_ATTESTATION_SCHEMA_V1,
        backend: "fastembed-onnxruntime-cpu".to_owned(),
        implementation_revision: "fastembed-5.17.2-ort-2.0.0-rc.12".to_owned(),
        protocol_revision: "key-arctic-xs-q-v1".to_owned(),
        numeric_profile: "dynamic-int8-weights-f32-cls-output-l2-v1".to_owned(),
        provenance_manifest_fingerprint: manifest_hash,
        space_fingerprint: space.fingerprint(),
        golden_vectors,
    };
    let identity = EmbeddingIdentityBundleV1 {
        space,
        producer,
        input,
        storage: VectorStorageIdentityV1 {
            schema_version: VECTOR_STORAGE_IDENTITY_SCHEMA_V1,
            format: "in-memory-f32-v1".to_owned(),
            quantization: QuantizationFormat::F32,
            endianness: "native-f32-values".to_owned(),
            vector_normalization: "l2-f32-v1".to_owned(),
            dimension: DIMENSION as u32,
        },
    };
    identity.validate().map_err(|error| error.to_string())?;
    Ok(identity)
}

fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm.is_finite() && norm > f32::EPSILON {
        for value in vector {
            *value /= norm;
        }
    } else {
        vector.fill(0.0);
    }
}
