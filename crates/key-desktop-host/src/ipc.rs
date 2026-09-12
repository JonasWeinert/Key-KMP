//! Binary framing keeps PDF bytes outside JSON and bounds transport allocations.
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    ops::Deref,
};
pub const MAX_JSON: usize = 1024 * 1024;
pub const MAX_BINARY: usize = 32 * 1024 * 1024;
pub struct HostState<'a, T>(pub &'a T);
impl<T> HostState<'_, T> {
    pub fn inner(&self) -> &T {
        self.0
    }
}
impl<T> Deref for HostState<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}
pub enum InvokeBody {
    Raw(Vec<u8>),
    #[allow(dead_code)]
    Json,
}
pub struct Request<'a> {
    pub headers: &'a http::HeaderMap,
    pub body: &'a InvokeBody,
}
impl Request<'_> {
    pub fn headers(&self) -> &http::HeaderMap {
        self.headers
    }
    pub fn body(&self) -> &InvokeBody {
        self.body
    }
}
pub struct Response(pub Vec<u8>);
impl Response {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}
pub enum Output {
    Json(serde_json::Value),
    Binary(Vec<u8>),
}
pub fn json_output(value: impl Serialize) -> Result<Output, String> {
    serde_json::to_value(value)
        .map(Output::Json)
        .map_err(|e| e.to_string())
}
pub fn arg<T: serde::de::DeserializeOwned>(
    args: &serde_json::Value,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(serde_json::Value::Null))
        .map_err(|e| format!("Invalid {key}: {e}"))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub id: u64,
    pub command: String,
    #[serde(default)]
    pub args: serde_json::Value,
    #[serde(default)]
    pub binary_length: usize,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
}
pub fn read_request(input: &mut impl Read) -> Result<Option<(Envelope, Vec<u8>)>, String> {
    let mut length = [0; 4];
    match input.read(&mut length[..1]) {
        Ok(0) => return Ok(None),
        Ok(_) => (),
        Err(e) => return Err(e.to_string()),
    }
    input
        .read_exact(&mut length[1..])
        .map_err(|e| e.to_string())?;
    let len = u32::from_le_bytes(length) as usize;
    if len > MAX_JSON {
        return Err("Control frame exceeds 1 MiB".into());
    }
    let mut header = vec![0; len];
    input.read_exact(&mut header).map_err(|e| e.to_string())?;
    let request: Envelope = serde_json::from_slice(&header).map_err(|e| e.to_string())?;
    if request.binary_length > MAX_BINARY {
        return Err("Binary frame exceeds 32 MiB".into());
    }
    let mut binary = vec![0; request.binary_length];
    input.read_exact(&mut binary).map_err(|e| e.to_string())?;
    Ok(Some((request, binary)))
}
pub fn write_response(
    output: &mut impl Write,
    id: u64,
    result: Result<Output, String>,
) -> Result<(), String> {
    let (header, binary) = match result {
        Ok(Output::Json(value)) => (
            serde_json::json!({"id":id,"ok":true,"result":value,"binaryLength":0}),
            Vec::new(),
        ),
        Ok(Output::Binary(bytes)) if bytes.len() <= MAX_BINARY => (
            serde_json::json!({"id":id,"ok":true,"binaryLength":bytes.len()}),
            bytes,
        ),
        Ok(Output::Binary(_)) => (
            serde_json::json!({"id":id,"ok":false,"error":"Response exceeds binary budget; use ranges","binaryLength":0}),
            Vec::new(),
        ),
        Err(error) => (
            serde_json::json!({"id":id,"ok":false,"error":error,"binaryLength":0}),
            Vec::new(),
        ),
    };
    let mut header = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    if header.len() > MAX_JSON {
        header=serde_json::to_vec(&serde_json::json!({"id":id,"ok":false,"error":"Response exceeds control budget","binaryLength":0})).unwrap();
    }
    output
        .write_all(&(header.len() as u32).to_le_bytes())
        .and_then(|_| output.write_all(&header))
        .and_then(|_| output.write_all(&binary))
        .and_then(|_| output.flush())
        .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_roundtrip_and_truncation() {
        let h = br#"{"id":3,"command":"library_import_chunk","binaryLength":4}"#;
        let mut frame = (h.len() as u32).to_le_bytes().to_vec();
        frame.extend(h);
        frame.extend([0, 255, 3, 9]);
        let (request, bytes) = read_request(&mut frame.as_slice()).unwrap().unwrap();
        assert_eq!(request.id, 3);
        assert_eq!(bytes, [0, 255, 3, 9]);
        assert!(read_request(&mut &frame[..frame.len() - 1]).is_err());
    }
    #[test]
    fn oversized_header_rejected_before_allocation() {
        assert!(read_request(&mut ((MAX_JSON + 1) as u32).to_le_bytes().as_slice()).is_err());
    }
    #[test]
    fn binary_response_is_not_json_encoded() {
        let mut out = Vec::new();
        write_response(&mut out, 7, Ok(Output::Binary(vec![0, 255]))).unwrap();
        let len = u32::from_le_bytes(out[..4].try_into().unwrap()) as usize;
        assert_eq!(&out[4 + len..], &[0, 255]);
    }
}
