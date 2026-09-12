//! Versioned artifact envelope. Existing zlib JSON remains readable during migration.
use crate::{Result, err};
use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
const MAGIC: &[u8; 8] = b"KEYART01";
const MAX_BYTES: usize = 64 * 1024 * 1024;
pub(crate) fn encode<T: Serialize>(kind: &str, value: &T) -> Result<Vec<u8>> {
    // Postcard preserves the exact floating-point geometry and encodes integer
    // counts compactly. Dynamic JSON artifacts retain the JSON codec.
    let binary = matches!(kind, "native-page" | "embedding");
    let raw = if binary {
        postcard::to_allocvec(value).map_err(err)?
    } else {
        serde_json::to_vec(value).map_err(err)?
    };
    if raw.len() > MAX_BYTES {
        return Err("Artifact exceeds the 64 MiB decoded-page limit".into());
    }
    let mut out = Vec::with_capacity(49);
    out.extend_from_slice(MAGIC);
    out.push(u8::from(binary));
    out.extend_from_slice(&(raw.len() as u64).to_le_bytes());
    out.extend_from_slice(&Sha256::digest(&raw));
    let mut encoder = ZlibEncoder::new(out, Compression::fast());
    encoder.write_all(&raw).map_err(err)?;
    encoder.finish().map_err(err)
}
pub(crate) fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    let (codec, payload, expected) = if bytes.starts_with(MAGIC) {
        if bytes.len() < 49 {
            return Err("Truncated artifact header".into());
        }
        let length = u64::from_le_bytes(bytes[9..17].try_into().map_err(err)?);
        if length > MAX_BYTES as u64 {
            return Err("Artifact decoded size exceeds limit".into());
        }
        (
            bytes[8],
            &bytes[49..],
            Some((length as usize, &bytes[17..49])),
        )
    } else {
        (0, bytes, None)
    };
    let mut raw = Vec::new();
    ZlibDecoder::new(payload)
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(err)?;
    if raw.len() > MAX_BYTES {
        return Err("Artifact decoded size exceeds limit".into());
    }
    if let Some((length, checksum)) = expected {
        if raw.len() != length || Sha256::digest(&raw).as_slice() != checksum {
            return Err("Artifact checksum mismatch".into());
        }
    }
    match codec {
        0 => serde_json::from_slice(&raw).map_err(err),
        1 => postcard::from_bytes(&raw).map_err(err),
        _ => Err("Unknown artifact codec".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Serialize, serde::Deserialize, PartialEq, Debug)]
    struct Geometry {
        page: u32,
        text: String,
        rects: Vec<[f32; 4]>,
    }
    #[test]
    fn binary_geometry_is_exact_legacy_json_reads_and_corruption_fails() {
        let value = Geometry {
            page: 3,
            text: "Ω ﬁ".into(),
            rects: vec![[0.1, 0.23, 512.125, 0.0]; 1000],
        };
        let binary = encode("native-page", &value).unwrap();
        assert_eq!(decode::<Geometry>(&binary).unwrap(), value);
        let mut old = ZlibEncoder::new(Vec::new(), Compression::fast());
        serde_json::to_writer(&mut old, &value).unwrap();
        assert_eq!(decode::<Geometry>(&old.finish().unwrap()).unwrap(), value);
        let mut corrupted = binary;
        corrupted[17] ^= 1;
        assert!(
            decode::<Geometry>(&corrupted)
                .unwrap_err()
                .contains("checksum")
        );
    }
}
