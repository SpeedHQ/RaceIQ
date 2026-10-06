use serde_json::{Value, json};
use std::{fs, io::{BufWriter, Write, copy}};
use super::{paths, response};

pub(super) fn run(operation: &str, input: Value, config: &Value) -> Result<Value, String> {
    if operation != "read-capture" && operation != "read-lap-window" { return Err(format!("Unsupported replay operation: {operation}")); }
    let (job_id, out) = paths::job_dir(&input, config)?;
    let source = input.get("input").unwrap_or(&input);
    let raw_path = source.get("path").and_then(Value::as_str).ok_or("Missing capture path")?;
    let allowed=paths::authorized_capture_path(raw_path,config)?;
    let mut options = input.get("options").cloned().unwrap_or_else(|| json!({}));
    let option_object=options.as_object_mut().ok_or("Replay options must be an object")?;
    let game = option_object.get("gameId").and_then(Value::as_str)
        .or_else(|| input.get("gameId").and_then(Value::as_str))
        .ok_or("Missing replay gameId")?.to_owned();
    option_object.entry("gameId").or_insert_with(||json!(game));
    let mut offset_encoding = input.get("offsetEncoding").and_then(Value::as_str).unwrap_or("byte").to_owned();
    if !matches!(offset_encoding.as_str(),"byte"|"packet-index"|"legacy-bin-byte-offset"){return Err("Unsupported capture offset encoding".into());}
    let context_offset=input.get("contextOffset").filter(|v|!v.is_null()).map(parse_u64).transpose()?;
    let is_motec = allowed.file_name().and_then(|v|v.to_str()).is_some_and(|v|v.to_ascii_lowercase().ends_with(".motec.zip"));
    if operation == "read-capture" && !is_motec {
        return stream_capture_replay(&allowed, &game, offset_encoding, context_offset, &job_id, &out);
    }
    let mut decoded: Vec<(u64, Option<u64>, Value, u64)> = Vec::new();
    let mut frame_offsets: Vec<(u64,u64)> = Vec::new();
    let mut markers: Vec<Value> = Vec::new();
    if is_motec {

        let (packets, encoding) = super::motec::read_packets(&allowed, &options, config)?;
        offset_encoding = encoding.clone();
        let bytes_per_record = if game == "acc" { 3076u64 } else if game == "ac-evo" { 5000u64 } else { return Err(format!("MoTeC target game unsupported: {game}")); };
        for (index, packet) in packets.into_iter().enumerate() {
            let frame_index=index as u64;
            let offset = if encoding == "packet-index" { frame_index } else { 12u64.checked_add(frame_index.checked_mul(bytes_per_record).ok_or("MoTeC offset overflow")?).ok_or("MoTeC offset overflow")? };
            frame_offsets.push((offset,frame_index));
            decoded.push((offset, None, packet, frame_index));
        }
    } else {
        let bytes = fs::read(&allowed).map_err(|e|format!("Read capture: {e}"))?;
        let plain = super::archive::prepare_import_bytes(&bytes)?;
        let mut records = super::archive::ImportDecoder::new(&plain)?;
        let mut parser = crate::games::GameParser::new(&game)?;
        let packet_index = offset_encoding == "packet-index";
        let mut frame_index=0u64;
        while let Some(record) = records.next()? {
            if record.kind==crate::formats::RecordKind::Segment {
                parser.reset();
                let marker_offset=if offset_encoding=="packet-index"{frame_index}else{record.offset};
                markers.push(json!({"offset":marker_offset.to_string(),"kind":"segment-boundary"}));
                continue;
            }
            let logical_offset=if packet_index {frame_index} else {record.offset};
            let source_frame=if record.kind==crate::formats::RecordKind::Frame {
                let index=frame_index;frame_index+=1;frame_offsets.push((logical_offset,index));Some(index)
            }else{None};
            let parsed=parser.feed(record.payload,record.time_ms.unwrap_or(0))?;
            if record.kind==crate::formats::RecordKind::Context {
                markers.push(json!({"offset":logical_offset.to_string(),"kind":"context","packet":parsed}));
            } else if let (Some(packet),Some(source_frame))=(parsed,source_frame) {
                decoded.push((logical_offset,record.time_ms,packet,source_frame));
            }
        }
    }

    let selected = if operation=="read-capture" { decoded.into_iter().map(|(offset,time,packet,_)|json!({"offset":offset.to_string(),"frameTimeMs":time.map(|v|v.to_string()),"packet":packet})).collect::<Vec<_>>() }
    else {
        let ranges=parse_ranges(&input)?;
        let mut result=Vec::new();
        for (start,count) in ranges {
            let first=frame_offsets.iter().find(|(offset,_)|*offset==start).map(|(_,index)|*index).ok_or_else(||format!("Capture has no source frame at requested offset {start}"))?;
            let end=first.checked_add(count).ok_or("Replay range overflow")?;
            if end>frame_offsets.len() as u64{return Err("Requested replay range extends beyond available capture records".into());}
            for (offset,time,packet,source_frame) in &decoded {
                if *source_frame>=first&&*source_frame<end {result.push(json!({"offset":offset.to_string(),"frameTimeMs":time.map(|v|v.to_string()),"packet":packet}));}
            }
        }
        result
    };
    if let Some(context)=context_offset{
        let context_text=context.to_string();
        if !markers.iter().any(|marker|marker.get("kind").and_then(Value::as_str)==Some("context")&&marker.get("offset").and_then(Value::as_str)==Some(context_text.as_str())){
            return Err(format!("Capture has no context marker at requested offset {context}"));
        }
    }
    let manifest=json!({"version":1,"jobId":job_id,"operation":operation,"gameId":game,
        "offsetEncoding":offset_encoding,"contextOffset":context_offset.map(|v|v.to_string()),
        "packetCount":selected.len(),"packets":selected,"markers":markers});
    let result_path=out.join("result.json");
    fs::write(&result_path,serde_json::to_vec(&manifest).map_err(|e|format!("Serialize replay result: {e}"))?).map_err(|e|format!("Write replay result: {e}"))?;
    Ok(response(&job_id,&result_path))
}
fn stream_capture_replay(path:&std::path::Path, game:&str, offset_encoding:String, context_offset:Option<u64>, job_id:&str, out:&std::path::Path)->Result<Value,String>{
    let bytes=fs::read(path).map_err(|e|format!("Read capture: {e}"))?;
    let plain=super::archive::prepare_import_bytes(&bytes)?;
    let mut records=super::archive::ImportDecoder::new(&plain)?;
    let packets_path=out.join("replay-packets.tmp");
    let result_path=out.join("result.json");
    let mut packet_writer=BufWriter::new(fs::File::create(&packets_path).map_err(|e|format!("Create replay output: {e}"))?);
    let mut parser=crate::games::GameParser::new(game)?;
    let mut markers=Vec::new();
    let packet_index=offset_encoding=="packet-index";
    let mut frame_index=0u64;
    let mut packet_count=0usize;
    packet_writer.write_all(b"[").map_err(|e|e.to_string())?;
    while let Some(record)=records.next()? {
        if record.kind==crate::formats::RecordKind::Segment {
            parser.reset();
            let marker_offset=if packet_index{frame_index}else{record.offset};
            markers.push(json!({"offset":marker_offset.to_string(),"kind":"segment-boundary"}));
            continue;
        }
        let logical_offset=if packet_index{frame_index}else{record.offset};
        if record.kind==crate::formats::RecordKind::Frame {frame_index+=1;}
        let parsed=parser.feed(record.payload,record.time_ms.unwrap_or(0))?;
        if record.kind==crate::formats::RecordKind::Context {
            markers.push(json!({"offset":logical_offset.to_string(),"kind":"context","packet":parsed}));
        } else if let Some(packet)=parsed {
            if packet_count>0 {packet_writer.write_all(b",").map_err(|e|e.to_string())?;}
            serde_json::to_writer(&mut packet_writer,&json!({"offset":logical_offset.to_string(),"frameTimeMs":record.time_ms.map(|v|v.to_string()),"packet":packet}))
                .map_err(|e|format!("Serialize replay packet: {e}"))?;
            packet_count+=1;
        }
    }
    if let Some(context)=context_offset {
        let context_text=context.to_string();
        if !markers.iter().any(|marker|marker.get("kind").and_then(Value::as_str)==Some("context")&&marker.get("offset").and_then(Value::as_str)==Some(context_text.as_str())) {
            return Err(format!("Capture has no context marker at requested offset {context}"));
        }
    }
    packet_writer.write_all(b"]").map_err(|e|e.to_string())?;
    packet_writer.flush().map_err(|e|format!("Flush replay packets: {e}"))?;
    drop(packet_writer);
    let mut result=BufWriter::new(fs::File::create(&result_path).map_err(|e|format!("Create replay manifest: {e}"))?);
    write!(result,"{{\"version\":1,\"jobId\":{},\"operation\":\"read-capture\",\"gameId\":{},\"offsetEncoding\":{},\"contextOffset\":{},\"packetCount\":{},\"packets\":",
        serde_json::to_string(job_id).map_err(|e|e.to_string())?,
        serde_json::to_string(game).map_err(|e|e.to_string())?,
        serde_json::to_string(&offset_encoding).map_err(|e|e.to_string())?,
        serde_json::to_string(&context_offset.map(|v|v.to_string())).map_err(|e|e.to_string())?,packet_count).map_err(|e|e.to_string())?;
    copy(&mut fs::File::open(&packets_path).map_err(|e|e.to_string())?,&mut result).map_err(|e|format!("Write replay manifest: {e}"))?;
    write!(result,",\"markers\":{}}}",serde_json::to_string(&markers).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    result.flush().map_err(|e|format!("Flush replay manifest: {e}"))?;
    drop(result);
    fs::remove_file(packets_path).map_err(|e|format!("Remove replay temporary: {e}"))?;
    Ok(response(job_id,&result_path))
}


fn parse_ranges(input:&Value)->Result<Vec<(u64,u64)>,String>{
    if let Some(values)=input.get("ranges").and_then(Value::as_array){
        let mut ranges=Vec::with_capacity(values.len());
        for value in values {let offset=parse_u64(value.get("offset").ok_or("Range missing offset")?)?;let count=value.get("count").and_then(Value::as_u64).ok_or("Range missing count")?;if count>10_000_000{return Err("Requested replay window is too large".into())}ranges.push((offset,count));}
        Ok(ranges)
    }else{let offset=parse_u64(input.get("offset").ok_or("Missing offset")?)?;let count=input.get("count").and_then(Value::as_u64).ok_or("Missing count")?;if count>10_000_000{return Err("Requested replay window is too large".into())}Ok(vec![(offset,count)])}
}
fn parse_u64(value:&Value)->Result<u64,String>{
    let text=value.as_str().ok_or("Offset must be decimal string")?;
    if text.is_empty()||(text.len()>1&&text.starts_with('0'))||!text.bytes().all(|byte|byte.is_ascii_digit()){return Err("Invalid decimal offset".into())}
    text.parse().map_err(|_|"Offset out of range".into())
}
