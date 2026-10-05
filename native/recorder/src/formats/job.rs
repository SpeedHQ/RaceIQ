use super::{decode_records,encode_capture_migration,encode_lap_slice,read_legacy_source,RecordKind,SourceRecord};
use flate2::read::MultiGzDecoder;
use serde_json::{json,Value};
use std::{fs,io::Read,path::{Path,PathBuf}};
use crate::imports::output_path;
const MAX_INPUT:u64=1024*1024*1024;
fn field<'a>(v:&'a Value,key:&str)->Result<&'a str,String>{v.get(key).and_then(Value::as_str).ok_or_else(||format!("Missing {key}"))}
fn parse_u64(v:&Value,label:&str)->Result<u64,String>{let s=v.as_str().ok_or_else(||format!("{label} must be a decimal string"))?;if s.is_empty()||!s.bytes().all(|b|b.is_ascii_digit()){return Err(format!("Invalid {label}"))}s.parse().map_err(|_|format!("Invalid {label}"))}
fn source_path(raw:&str,roots:&[PathBuf])->Result<PathBuf,String>{let p=PathBuf::from(raw);if !p.is_absolute(){return Err("sourcePath must be absolute".into())}let p=p.canonicalize().map_err(|e|e.to_string())?;if !p.is_file()||!roots.iter().any(|r|p.starts_with(r)){return Err("sourcePath is outside staging and authorized sessions roots".into())}Ok(p)}
fn read_source(path:&Path,game:&str)->Result<(Vec<SourceRecord>,usize),String>{
 let size=fs::metadata(path).map_err(|e|e.to_string())?.len();if size>MAX_INPUT{return Err("Capture exceeds 1 GiB format job limit".into())}
 let data=fs::read(path).map_err(|e|e.to_string())?;let bytes=if data.starts_with(&[0x1f,0x8b]){let decoder=MultiGzDecoder::new(data.as_slice());let mut out=Vec::new();decoder.take(MAX_INPUT+1).read_to_end(&mut out).map_err(|e|e.to_string())?;if out.len()as u64>MAX_INPUT{return Err("Decompressed capture exceeds 1 GiB format job limit".into())}out}else{data};let length=bytes.len();
 if bytes.len()>=4&&u32::from_le_bytes(bytes[..4].try_into().unwrap())==u32::MAX{if bytes.len()<12{return Err("Truncated capture metadata header".into())}return Ok((decode_records(&bytes)?,length))}
 if let Some(legacy)=read_legacy_source(&bytes)?{if legacy.game!=game{return Err("Legacy dump game does not match requested gameId".into())}if game=="acc"{return Err("ACCTEST source dump requires Kunos triplet assembly before capture encoding".into())}let records=legacy.records.into_iter().map(|r|SourceRecord{offset:r.offset,time_ms:None,kind:if game=="iracing"&&r.payload.len()>=12&&r.payload[6]==1{RecordKind::Context}else{RecordKind::Frame},payload:r.payload}).collect();return Ok((records,length))}
 let records=decode_records(&bytes)?;if bytes.is_empty()||!records.is_empty(){Ok((records,length))}else{Err("Source file is not a supported canonical or legacy capture".into())}
}
fn job_id(input:&Value)->Result<&str,String>{let id=field(input,"jobId")?;if id.is_empty()||id.len()>128||!id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'){return Err("Invalid jobId".into())}Ok(id)}
fn context_records(game:&str,records:&[SourceRecord],start:u64)->Vec<SourceRecord>{
 let selected=records.iter().find(|r|r.offset==start&&r.kind==RecordKind::Frame).map(|r|r.payload.as_slice());
 let uid=if game=="f1-2025"{selected.filter(|b|b.len()>=29).map(|b|b[7..15].to_vec())}else{None};
 if !matches!(game,"f1-2025"|"ac-evo"|"iracing"){return Vec::new()}
 records.iter().filter(|r|r.offset<start&&r.payload.len()>0&&(r.kind==RecordKind::Frame||(game=="iracing"&&r.kind==RecordKind::Context))).filter(|r|if game=="f1-2025"{uid.as_ref().is_some_and(|u|r.payload.len()>=29&&r.payload[7..15]==u[..])}else{true}).map(|r|SourceRecord{offset:r.offset,time_ms:r.time_ms,kind:RecordKind::Context,payload:r.payload.clone()}).collect()
}
fn iracing_packet(parser:&mut crate::games::GameParser,record:&SourceRecord)->Result<Option<f64>,String>{let packet=parser.feed(&record.payload,record.time_ms.unwrap_or(0))?;Ok(packet.as_ref().and_then(|p|p.get("LastLap")).and_then(Value::as_f64))}
fn window_end(game:&str,records:&[SourceRecord],begin:usize,frame_count:usize,source_len:usize)->Result<usize,String>{
 if game!="iracing"{let wanted=frame_count.saturating_add(1);let mut seen=0;let mut end=begin;for i in begin..records.len(){let r=&records[i];if r.kind!=RecordKind::Frame{break}seen+=1;end=i+1;if seen==wanted{break}}return Ok(end)}
 let mut parser=crate::games::GameParser::new("iracing")?;for r in &records[..begin]{if r.kind==RecordKind::Frame||(!r.payload.is_empty()&&r.kind==RecordKind::Context){let _=iracing_packet(&mut parser,r)?;}}
 let mut end=begin;let mut seen=0usize;let mut stale=None::<f64>;
 for i in begin..records.len(){let r=&records[i];if r.kind==RecordKind::Segment{return Ok(end)}if r.kind!=RecordKind::Frame{if !r.payload.is_empty()&&r.kind==RecordKind::Context{let _=iracing_packet(&mut parser,r)?;end=i+1;continue}break}
  let last=iracing_packet(&mut parser,r)?;seen+=1;end=i+1;if seen<=frame_count{if let Some(value)=last{stale=Some(value)}}else if let(Some(current),Some(previous))=(last,stale){if current>0.0&&(current-previous).abs()>0.0001{return Ok(end)}}
 }
 let _=source_len;Ok(end)
}
pub fn run(operation:&str,input:Value,config:&Value)->Result<Value,String>{
 let id=job_id(&input)?;let game=field(&input,"gameId")?;if !matches!(game,"fm-2023"|"f1-2025"|"acc"|"ac-evo"|"iracing"|"lmu"){return Err("Unsupported gameId".into())}
 let staging=config.get("stagingRoot").or_else(||config.get("jobStagingRoot")).and_then(Value::as_str).ok_or("Missing configured stagingRoot")?;let staging=Path::new(staging).canonicalize().map_err(|e|format!("Resolve staging root: {e}"))?;
 let mut roots=vec![staging.clone()];if let Some(root)=config.get("sessionsRoot").and_then(Value::as_str){if let Ok(path)=Path::new(root).canonicalize(){roots.push(path)}}else if let Some(data)=config.get("dataDir").and_then(Value::as_str){if let Ok(path)=Path::new(data).join("sessions").canonicalize(){roots.push(path)}}
 let source=source_path(field(&input,"sourcePath")?,&roots)?;let output=output_path(field(&input,"outputRoot")?,&staging)?;let(records,source_len)=read_source(&source,game)?;
 let (encoded,frame_count,offsets)=if operation=="encode-capture"{
  let result=encode_capture_migration(game,&records).map_err(|e|e.to_string())?;let requested=input.get("oldOffsets").and_then(Value::as_array).ok_or("Missing oldOffsets")?;let mut mapped=Vec::with_capacity(requested.len());for item in requested{let old=parse_u64(item,"oldOffset")?;let new=result.offsets.iter().find(|(from,_)|*from==old).map(|(_,to)|*to).ok_or_else(||format!("No source record at requested oldOffset {old}"))?;mapped.push(json!({"oldOffset":old.to_string(),"newOffset":new.to_string()}));}let count=records.iter().filter(|r|r.kind==RecordKind::Frame).count();(result,count,mapped)
 }else if operation=="encode-lap-slices"{
  if input.get("policy").and_then(Value::as_str)!=Some("archive-lap-slices"){return Err("Unsupported lap-slice encoding policy".into())}let windows=input.get("windows").and_then(Value::as_array).ok_or("Missing windows")?;if windows.is_empty(){return Err("No lap windows supplied".into())}let mut selected=Vec::new();let mut total=0usize;
  for window in windows{let start=parse_u64(window.get("start").ok_or("Missing window start")?,"window start")?;let expected=window.get("frameCount").and_then(Value::as_u64).filter(|n|*n>0&&*n<=u32::MAX as u64).ok_or("Invalid window frameCount")? as usize;let begin=records.iter().position(|r|r.offset==start&&r.kind==RecordKind::Frame).ok_or_else(||format!("No source frame at window start {start}"))?;let stop=window_end(game,&records,begin,expected,source_len)?;let window_records=&records[begin..stop];let actual=window_records.iter().filter(|r|r.kind==RecordKind::Frame).count();if actual<expected{return Err(format!("Lap window at {start} contains {actual} frames; expected at least {expected}"))}
   selected.push(SourceRecord{offset:start,time_ms:None,kind:RecordKind::Segment,payload:Vec::new()});let contexts=context_records(game,&records,start);if !contexts.is_empty(){selected.push(SourceRecord{offset:start,time_ms:None,kind:RecordKind::Context,payload:Vec::new()});selected.extend(contexts);selected.push(SourceRecord{offset:start,time_ms:None,kind:RecordKind::Context,payload:Vec::new()});}selected.extend(window_records.iter().cloned());total+=actual;
  }
  let result=encode_lap_slice(game,&selected).map_err(|e|e.to_string())?;(result,total,Vec::new())
 }else{return Err(format!("Unsupported format operation {operation}"))};
 if encoded.bytes.len()as u64>MAX_INPUT{return Err("Encoded artifact exceeds 1 GiB job output limit".into())}
 let artifact=output.join(if operation=="encode-capture"{"capture.bin"}else{"lap-slices.bin"});let manifest_path=output.join("result.json");fs::write(&artifact,&encoded.bytes).map_err(|e|e.to_string())?;let artifact_text=artifact.to_string_lossy();let manifest=if operation=="encode-capture"{json!({"version":1,"jobId":id,"operation":operation,"artifactPath":artifact_text,"frameCount":frame_count,"offsets":offsets})}else{json!({"version":1,"jobId":id,"operation":operation,"artifactPath":artifact_text,"frameCount":frame_count})};fs::write(&manifest_path,serde_json::to_vec(&manifest).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;Ok(json!({"jobId":id,"resultPath":manifest_path.to_string_lossy()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    #[test]
    fn format_jobs_read_every_gzip_member() {
        let frames = [
            SourceRecord { offset: 12, time_ms: Some(100), kind: RecordKind::Frame, payload: vec![1, 2] },
            SourceRecord { offset: 30, time_ms: Some(200), kind: RecordKind::Frame, payload: vec![3, 4, 5] },
        ];
        let plain = super::super::encode_records("fm-2023", &frames, false).unwrap().bytes;
        let gzip = |bytes: &[u8]| {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(bytes).unwrap();
            encoder.finish().unwrap()
        };
        let split = plain.len() / 2;
        let mut compressed = gzip(&plain[..split]);
        compressed.extend(gzip(&plain[split..]));
        let path = std::env::temp_dir().join(format!("raceiq-format-{}.bin.gz", uuid::Uuid::new_v4()));
        fs::write(&path, compressed).unwrap();
        let result = read_source(&path, "fm-2023");
        fs::remove_file(path).unwrap();
        let (records, length) = result.unwrap();
        assert_eq!(length, plain.len());
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].payload, frames[0].payload);
        assert_eq!(records[1].payload, frames[1].payload);
        assert_eq!(records[0].time_ms, Some(100));
        assert_eq!(records[1].time_ms, Some(200));
    }
}
