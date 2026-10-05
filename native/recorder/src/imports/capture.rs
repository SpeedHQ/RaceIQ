use serde_json::{Value, json};
use std::{fs, path::Path};
use super::{archive, ibt, lmu_duckdb, motec, paths, response};

const MAX_CAPTURE: u64 = 1024 * 1024 * 1024;

pub(super) fn run(operation: &str, input: Value, config: &Value) -> Result<Value, String> {
    if !matches!(operation,"preview"|"import"|"reprocess"){return Err(format!("Unsupported recorder import operation: {operation}"));}
    let source_name = input.pointer("/input/originalName").and_then(Value::as_str).or_else(||input.pointer("/input/path").and_then(Value::as_str)).unwrap_or("");
    if operation=="import"&&input.pointer("/options/captureStorage").and_then(Value::as_str)==Some("raw")
        && !(source_name.to_ascii_lowercase().ends_with(".bin")||source_name.to_ascii_lowercase().ends_with(".bin.gz")){
        return Err("Raw capture storage is supported only for BIN imports".into());
    }
    if source_name.to_ascii_lowercase().ends_with(".ibt") {
        if operation == "preview" || operation == "import" { return ibt::run(operation, input, config); }
        return Err(format!("Operation {operation} is unsupported for IBT"));
    }
    let (job_id, output_dir) = paths::job_dir(&input, config)?;
    let source_value=input.pointer("/input/path").or_else(||input.get("path"));
    let source=if operation=="reprocess" {
        let raw=source_value.and_then(Value::as_str).ok_or("Missing reprocess input path")?;
        paths::authorized_capture_path(raw,config)?
    } else { paths::staged_input(&input,config)? };
    let name = input.pointer("/input/originalName").and_then(Value::as_str)
        .unwrap_or_else(|| source.file_name().and_then(|s| s.to_str()).unwrap_or("input"));
    let mut options = input.get("options").cloned().unwrap_or_else(|| json!({}));
    if operation=="reprocess" { options["rawFile"]=json!(source.to_string_lossy()); }
    if let Some(sidecar) = input.pointer("/input/sidecarPath").cloned() {
        options["sidecarPath"] = sidecar;
    }
    let lower_name = name.to_ascii_lowercase();
    let raw_storage=options.get("captureStorage").and_then(Value::as_str)==Some("raw");
    if operation=="import"&&raw_storage&&! (lower_name.ends_with(".bin")||lower_name.ends_with(".bin.gz")){
        return Err("Raw capture storage is supported only for BIN imports".into());
    }
    let mut result = if input.pointer("/input/format").and_then(Value::as_str)==Some("motec") || lower_name.ends_with(".motec.zip") || lower_name.ends_with(".ld") {
        motec::run(operation, &source, name, &options, &output_dir, config)?
    } else if lower_name.ends_with(".zip") {
        archive::run(operation, &source, name, &options, &output_dir, config)?
    } else if lower_name.ends_with(".duckdb") || lower_name.ends_with(".db") {
        lmu_duckdb::run(operation, &source, &options, &output_dir, config)?
    } else {
        let bytes = fs::read(&source).map_err(|e| format!("Read import input: {e}"))?;
        if bytes.len() as u64 > MAX_CAPTURE { return Err("Capture exceeds decompressed size limit".into()); }
        archive::capture_bytes(operation, &bytes, name, &options, &output_dir, config)?
    };
    normalize_manifest(&mut result,&job_id,operation);
    let manifest_path = output_dir.join("result.json");
    let serialized = serde_json::to_vec(&result).map_err(|e| format!("Serialize import manifest: {e}"))?;
    fs::write(&manifest_path, serialized).map_err(|e| format!("Write import manifest: {e}"))?;
    Ok(response(&job_id, Path::new(&manifest_path)))
}
fn normalize_manifest(result:&mut Value,job_id:&str,operation:&str){
    let mut object=match result.as_object().cloned(){Some(value)=>value,None=>serde_json::Map::new()};
    let mut sessions=object.remove("sessions").and_then(|value|value.as_array().cloned()).unwrap_or_default();
    let mut artifacts=object.remove("artifacts").and_then(|value|value.as_array().cloned()).unwrap_or_default();
    let members=object.remove("members").and_then(|value|value.as_array().cloned());
    let mut member_packet_count=0u64;
    if let Some(items)=members.as_ref(){
        for member in items{
            member_packet_count=member_packet_count.saturating_add(member.get("packetCount").and_then(Value::as_u64).unwrap_or(0));
            if let Some(items)=member.get("sessions").and_then(Value::as_array){sessions.extend(items.iter().cloned());}
            if let Some(items)=member.get("artifacts").and_then(Value::as_array){artifacts.extend(items.iter().cloned());}
        }
    }
    let packet_count=object.get("packetCount").and_then(Value::as_u64).or_else(||object.get("estimatedPacketCount").and_then(Value::as_u64)).unwrap_or_else(||if member_packet_count>0{member_packet_count}else{sessions.iter().map(|s|s.get("packetCount").and_then(Value::as_u64).unwrap_or(0)).sum()});
    if operation=="preview"{let preview=Value::Object(object.clone());object.insert("preview".into(),preview);sessions.clear();}
    for session in &mut sessions{
        if let Some(fields)=session.as_object_mut(){
            let identity=fields.get("identity").cloned().unwrap_or_else(||json!({}));
            let number=|key:&str|identity.get(key).and_then(Value::as_i64).or_else(||identity.get(key).and_then(Value::as_f64).map(|n|n as i64));
            if let Some(value)=number("carOrdinal"){fields.insert("carOrdinal".into(),json!(value));}
            if let Some(value)=number("trackOrdinal"){fields.insert("trackOrdinal".into(),json!(value));}
            fields.entry("laps").or_insert(json!([]));
            let sparse=fields.get("sparse").and_then(Value::as_bool).unwrap_or(false);
            fields.entry("sparseCapture").or_insert(json!(sparse));
            if let Some(laps)=fields.get_mut("laps").and_then(Value::as_array_mut){for lap in laps{
                if let Some(data)=lap.as_object_mut(){
                    let recipe=data.get("analysisRecipe").cloned().unwrap_or(Value::Null);
                    if let Some(offset)=recipe.pointer("/ranges/0/offset").cloned(){data.entry("rawByteOffset").or_insert(offset);}
                    if let Some(ranges)=recipe.get("ranges").and_then(Value::as_array){
                        let count=ranges.iter().filter_map(|range|range.get("count").and_then(Value::as_u64)).sum::<u64>();
                        data.entry("rawFrameCount").or_insert(json!(count));
                    }
                }
            }}
        }
    }
    let artifacts:Vec<Value>=artifacts.into_iter().filter_map(|artifact|if artifact.is_string(){Some(artifact)}else{artifact.get("path").cloned()}).collect();
    object.insert("version".into(),json!(1));
    object.insert("jobId".into(),json!(job_id));
    object.insert("operation".into(),json!(operation));
    object.insert("packetCount".into(),json!(packet_count));
    object.insert("sessions".into(),json!(sessions));
    object.insert("artifacts".into(),json!(artifacts));
    if let Some(members)=members{object.insert("members".into(),json!(members));}
    *result=Value::Object(object);
}

pub(super) fn detect_game(records:&[crate::formats::SourceRecord])->Result<String,String>{
    const GAMES:[&str;6]=["fm-2023","f1-2025","acc","ac-evo","iracing","lmu"];
    for game in GAMES{
        let Ok(mut parser)=crate::games::GameParser::new(game) else{continue};
        for record in records.iter().filter(|record|record.kind==crate::formats::RecordKind::Frame){
            // Recognize UDP transport even when initial packets contain no driving telemetry.
            let frame = &record.payload;
            if (game == "fm-2023" && (324..=400).contains(&frame.len()))
                || (game == "f1-2025" && frame.len() >= 29 && u16::from_le_bytes([frame[0], frame[1]]) == 2025) {
                return Ok(game.to_owned());
            }
            if matches!(parser.feed(&record.payload,record.time_ms.unwrap_or(0)),Ok(Some(_))){return Ok(game.to_owned());}
        }
    }
    Err("Unable to identify capture game from first 20 source frames".into())
}

pub(super) fn process_records(
    operation:&str,
    records:Vec<crate::formats::SourceRecord>,
    name:&str,
    options:&Value,
    output_dir:&Path,
    config:&Value,
) -> Result<Value,String> {
    process_record_results(operation, records.into_iter().map(Ok), name, options, output_dir, config)
}

pub(super) fn process_record_results<I>(
    operation:&str,
    records:I,
    name:&str,
    options:&Value,
    output_dir:&Path,
    _config:&Value,
) -> Result<Value,String>
where I:IntoIterator<Item=Result<crate::formats::SourceRecord,String>> {
    let mut source=records.into_iter();
    let mut prefix=Vec::with_capacity(20);
    let mut sniff_frames=0usize;
    while sniff_frames<20 {
        match source.next(){
            Some(record)=>{let record=record?;if record.kind==crate::formats::RecordKind::Frame{sniff_frames+=1;}prefix.push(record);}
            None=>break,
        }
    }
    let records=prefix.clone().into_iter().map(Ok).chain(source);
    let game = options.get("gameId").and_then(Value::as_str).map(str::to_owned)
        .or_else(|| options.get("game").and_then(Value::as_str).map(str::to_owned))
        .or_else(|| {
            let sniff = prefix.iter().filter(|record| record.kind == crate::formats::RecordKind::Frame)
                .take(20).cloned().collect::<Vec<_>>();
            detect_game(&sniff).ok()
        })
        .ok_or("Unable to identify capture game from first 20 source frames")?;
    let capture_id = uuid::Uuid::new_v4().to_string();
    let mut parser = crate::games::GameParser::new(&game)?;
    let mut detector = crate::detection::Detector::new(&game)?;
    let raw_storage=options.get("captureStorage").and_then(Value::as_str)==Some("raw");
    let mut writer = if operation == "import" {
        Some(if raw_storage {crate::writer::CaptureWriter::new_raw(output_dir,&game,&capture_id)?}
            else {crate::writer::CaptureWriter::new(output_dir, &game, &capture_id)?})
    } else { None };
    let mut identity=json!({});
    let mut laps=Vec::new();
    let mut packet_count=0u64;
    let mut artifacts=Vec::new();
    let mut events=Vec::new();
    let mut completion=Value::Null;
    let processing=(||->Result<(),String>{
    for record in records {
        let record=record?;
        match record.kind {
            crate::formats::RecordKind::Segment => {
                parser.reset();
                for event in detector.finish("segment-boundary")? { collect_event(event,&mut identity,&mut laps,&mut events,&mut completion); }
                detector.reset();
                if let Some(writer)=writer.as_mut(){writer.segment()?;}
            }
            crate::formats::RecordKind::Context => {
                if !record.payload.is_empty(){
                    if let Some(writer)=writer.as_mut(){writer.context(&record.payload)?;}
                    let _=parser.feed(&record.payload,record.time_ms.unwrap_or(0))?;
                }
            }
            crate::formats::RecordKind::Frame => {
                let offset=if let Some(writer)=writer.as_mut(){writer.write(&record.payload,record.time_ms)?}else{record.offset};
                if let Some(packet)=parser.feed(&record.payload,record.time_ms.unwrap_or(0))? {
                    packet_count+=1;
                    for event in detector.feed(packet,offset)?{collect_event(event,&mut identity,&mut laps,&mut events,&mut completion);}
                }
            }
        }
    }
    for event in detector.finish("import-eof")?{collect_event(event,&mut identity,&mut laps,&mut events,&mut completion);}
    Ok(())
    })();
    if let Err(error)=processing{
        if let Some(writer)=writer.as_mut(){let path=writer.path().to_path_buf();let _=writer.close();let _=fs::remove_file(path);}
        return Err(error);
    }
    if let Some(writer)=writer.as_mut(){
        let path=writer.path().to_path_buf();
        let closed=match writer.close(){Ok(value)=>value,Err(error)=>{let _=fs::remove_file(path);return Err(error);}};
        if closed.get("count").and_then(Value::as_u64).unwrap_or(0)>0{artifacts.push(closed.clone());}
        else if let Some(path)=closed.get("path").and_then(Value::as_str){let _=fs::remove_file(path);}
    }
    let raw_file=options.get("rawFile").cloned().or_else(||artifacts.first().and_then(|a|a.get("path")).cloned()).unwrap_or(Value::Null);
    let session=json!({"engineSessionId":capture_id,"gameId":game,"identity":identity,"rawFile":raw_file,
        "source":null,"sparse":!raw_storage,"sparseCapture":!raw_storage,"detectorVersion":"rust-recorder_v1","laps":laps});
    let sessions=if operation=="import"&&raw_file.is_null(){Vec::<Value>::new()}else{vec![session]};
    Ok(json!({"version":1,"kind":"capture","name":name,"gameId":game,"engineSessionId":capture_id,
        "identity":identity,"packetCount":packet_count,"sessions":sessions,"events":events,
        "completion":completion,"artifacts":artifacts}))
}

fn collect_event(event:Value,identity:&mut Value,laps:&mut Vec<Value>,events:&mut Vec<Value>,completion:&mut Value){
    match event.get("kind").and_then(Value::as_str){
        Some("SESSION_STARTED")|Some("SESSION_IDENTITY_UPDATED")=>{if let Some(data)=event.get("data"){*identity=data.clone();}}
        Some("LAP_RECORDED")=>{if let Some(data)=event.get("data"){let mut lap=data.clone();if let Some(map)=lap.as_object_mut(){
            if let Some(offset)=map.get("analysisRecipe").and_then(|r|r.pointer("/ranges/0/offset")).cloned(){map.entry("rawByteOffset").or_insert(offset);}
            if let Some(ranges)=map.get("analysisRecipe").and_then(|r|r.get("ranges")).and_then(Value::as_array){
                let count=ranges.iter().filter_map(|r|r.get("count").and_then(Value::as_u64)).sum::<u64>();
                map.entry("rawFrameCount").or_insert(json!(count));
            }
        }laps.push(lap);}}
        Some("RECORDING_COMPLETED")=>*completion=event.get("data").cloned().unwrap_or(Value::Null),
        _=>{}
    }
    events.push(event);
}

pub(super) fn process_packets(
    operation:&str,
    packets:Vec<Value>,
    name: &str,
    options: &Value,
    source_archive_path: Option<&Path>,
) -> Result<Value, String> {
    if operation == "reprocess" && source_archive_path.is_none() {
        return Err("MoTeC reprocess requires authorized source archive".into());
    }
    let game = options.get("gameId").and_then(Value::as_str).ok_or("Missing gameId for MoTeC import")?;
    if !matches!(game, "acc" | "ac-evo") { return Err(format!("MoTeC target game unsupported: {game}")); }
    let capture_id = uuid::Uuid::new_v4().to_string();
    let encoding=options.get("offsetEncoding").and_then(Value::as_str).unwrap_or("packet-index");
    if encoding!="packet-index"&&encoding!="legacy-bin-byte-offset"{return Err("Unsupported MoTeC offset encoding".into());}
    let record_bytes=if game=="acc"{3076u64}else{5000u64};
    let mut detector = crate::detection::Detector::new(game)?;
    let mut identity = json!({});
    let mut laps = Vec::new();
    let mut events=Vec::new();
    let mut completion=Value::Null;
    // Channel logs contain decoded packets, not binary context records.
    let mut collect_packet_event = |mut event: Value| {
        if let Some(recipe) = event.pointer_mut("/data/analysisRecipe").and_then(Value::as_object_mut) {
            recipe.remove("contextOffset");
        }
        collect_event(event, &mut identity, &mut laps, &mut events, &mut completion);
    };
    for (index, packet) in packets.iter().enumerate() {
        let offset=if encoding=="packet-index"{index as u64}else{12u64.checked_add((index as u64).checked_mul(record_bytes).ok_or("MoTeC legacy offset overflow")?).ok_or("MoTeC legacy offset overflow")?};
        for event in detector.feed(packet.clone(), offset)? {
            collect_packet_event(event);
        }
    }
    for event in detector.finish("import-eof")? { collect_packet_event(event); }
    if !identity.is_object(){identity=json!({});}
    for key in ["carOrdinal","trackOrdinal"]{if identity.get(key).is_none(){if let Some(value)=options.get(key){identity[key]=value.clone();}}}
    let source_path = source_archive_path.map(|p|p.to_string_lossy().into_owned());
    let artifact = source_path.clone().map(|path|json!({"path":path,"kind":"motec-source-archive"}));
    Ok(json!({"version":1,"kind":"motec","name":name,"gameId":game,"packetCount":packets.len(),
        "sourceIdentity":{"carTrack":options.get("carTrack").cloned().unwrap_or(Value::Null)},
        "sessions":[{"engineSessionId":capture_id,"gameId":game,"identity":identity,"rawFile":source_path,
            "source":"motec","offsetEncoding":encoding,"sparse":false,"detectorVersion":"rust-recorder_v1","laps":laps}],
        "events":events,"completion":completion,"artifacts":artifact.into_iter().collect::<Vec<_>>()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_udp_capture_before_driving_telemetry() {
        let record = |payload| crate::formats::SourceRecord {
            offset: 0, time_ms: None, kind: crate::formats::RecordKind::Frame, payload,
        };
        assert_eq!(detect_game(&[record(vec![0; 324])]).unwrap(), "fm-2023");
        let mut session_packet = vec![0; 29];
        session_packet[..2].copy_from_slice(&2025u16.to_le_bytes());
        session_packet[6] = 1;
        assert_eq!(detect_game(&[record(session_packet)]).unwrap(), "f1-2025");
    }
}
