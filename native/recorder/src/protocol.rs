use serde_json::Value;
use std::io::{self, Read, Write};

pub const MAX_BODY: usize = 16 * 1024 * 1024;
pub const MIN_BODY: usize = 5;
pub const HELLO: u8 = 1;
pub const REQUEST: u8 = 2;
pub const RESPONSE: u8 = 3;
pub const LIVE_FRAME: u8 = 4;
pub const EVENT: u8 = 5;
pub const PROGRESS: u8 = 6;
pub const STATUS: u8 = 7;
pub const FATAL: u8 = 8;

#[derive(Debug)]
pub struct Message {
    pub opcode: u8,
    pub request_id: u32,
    pub payload: Vec<u8>,
}

pub fn read_message<R: Read>(reader: &mut R) -> io::Result<Option<Message>> {
    let mut header = [0u8; 4];
    let mut got = 0;
    while got < header.len() {
        match reader.read(&mut header[got..])? {
            0 if got == 0 => return Ok(None),
            0 => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated frame length")),
            n => got += n,
        }
    }
    let length = u32::from_le_bytes(header) as usize;
    if !(MIN_BODY..=MAX_BODY).contains(&length) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("invalid frame length {length}")));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let opcode = body[0];
    if !(HELLO..=FATAL).contains(&opcode) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unknown opcode {opcode}")));
    }
    let request_id = u32::from_le_bytes(body[1..5].try_into().expect("fixed request id"));
    Ok(Some(Message { opcode, request_id, payload: body[5..].to_vec() }))
}

pub fn write_message<W: Write>(writer: &mut W, opcode: u8, request_id: u32, payload: &[u8]) -> io::Result<()> {
    let length = payload.len().checked_add(MIN_BODY).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "message length overflow"))?;
    if length > MAX_BODY { return Err(io::Error::new(io::ErrorKind::InvalidData, "message exceeds 16 MiB")); }
    writer.write_all(&(length as u32).to_le_bytes())?;
    writer.write_all(&[opcode])?;
    writer.write_all(&request_id.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

pub fn json_message(opcode: u8, request_id: u32, value: &Value) -> io::Result<(u8, u32, Vec<u8>)> {
    let bytes = serde_json::to_vec(value).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    if bytes.len() + MIN_BODY > MAX_BODY { return Err(io::Error::new(io::ErrorKind::InvalidData, "JSON payload exceeds 16 MiB")); }
    Ok((opcode, request_id, bytes))
}
