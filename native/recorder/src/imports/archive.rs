use serde_json::{Value, json};
use std::{collections::{HashMap,HashSet}, fs::File, io::{Read,Seek,SeekFrom}, path::Path};
use zip::ZipArchive;
use super::paths;

const MAX_COMPRESSED: u64 = 512 * 1024 * 1024;
const MAX_MEMBER: u64 = 512 * 1024 * 1024;
const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 256;

pub(super) fn run(operation: &str, source: &Path, original_name: &str, options: &Value, out: &Path, config: &Value) -> Result<Value, String> {
    let len = std::fs::metadata(source).map_err(|e| e.to_string())?.len();
    if len > MAX_COMPRESSED { return Err("Archive exceeds compressed size limit".into()); }
    validate_zip_container(source)?;
    let file = File::open(source).map_err(|e| format!("Open archive: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;
    if archive.len() > MAX_ENTRIES { return Err("Archive contains too many entries".into()); }
    let mut seen=HashSet::new();
    let mut total=0u64;
    let mut files=Vec::<(String,Vec<u8>)>::new();
    for index in 0..archive.len() {
        let mut entry=archive.by_index(index).map_err(|e|format!("Read ZIP directory: {e}"))?;
        let name=entry.name().to_owned();
        paths::ensure_no_traversal(&name)?;
        let normalized=name.split('/').filter(|part|!part.is_empty()&&*part!=".").collect::<Vec<_>>().join("/");
        if !seen.insert(normalized){return Err(format!("Duplicate normalized archive path: {name}"));}
        if entry.is_dir(){continue}
        if entry.size()>MAX_MEMBER{return Err(format!("Archive member exceeds size limit: {name}"));}
        let mut bytes=Vec::with_capacity(entry.size().min(16*1024*1024)as usize);
        (&mut entry).take(MAX_MEMBER+1).read_to_end(&mut bytes).map_err(|e|format!("Decompress ZIP member {name}: {e}"))?;
        if bytes.len()as u64>MAX_MEMBER{return Err(format!("Archive member exceeds size limit: {name}"));}
        total=total.checked_add(bytes.len()as u64).ok_or("Archive size overflow")?;
        if total>MAX_TOTAL{return Err("Archive exceeds total decompressed size limit".into())}
        files.push((name,bytes));
    }
    files.sort_by(|a,b|a.0.cmp(&b.0));
    let manifest=files.iter().find(|(name,_)|name=="manifest.json")
        .and_then(|(_,bytes)|serde_json::from_slice::<Value>(bytes).ok());
    let mut manifest_entries=HashMap::<String,Value>::new();
    if let Some(entries)=manifest.as_ref().and_then(|value|value.get("entries")).and_then(Value::as_array){
        for entry in entries{
            if let (Some(name),Some(_))=(entry.get("file").and_then(Value::as_str),entry.get("gameId").and_then(Value::as_str)){
                manifest_entries.insert(name.to_owned(),entry.clone());
            }
        }
    }
    let supported=files.iter().filter(|(name,_)|supported_capture_name(name)).count();
    if supported==0{return Err("Zip contains no session captures (.bin/.bin.gz/.motec.zip). Exports from an older RaceIQ version can't be imported.".into())}
    let mut members=Vec::new();
    let mut errors=Vec::new();
    let mut skipped=Vec::new();
    for (name,bytes) in files{
        if !supported_capture_name(&name){continue}
        let entry=manifest_entries.get(&name);
        let result=if name.ends_with(".motec.zip"){
            match entry{
                Some(entry)=>{
                    let mut member_options=options.clone();
                    let Some(obj)=member_options.as_object_mut() else {
                        let error="Import options must be an object".to_owned();
                        errors.push(json!({"name":name,"error":error}));
                        skipped.push(json!({"name":name,"reason":"missing or unusable MoTeC manifest metadata"}));
                        continue;
                    };
                    let game=entry.get("gameId").and_then(Value::as_str);
                    let car=entry.get("carOrdinal").and_then(Value::as_i64);
                    let track=entry.get("trackOrdinal").and_then(Value::as_i64);
                    if game.is_none_or(|id|!known_game(id))||car.is_none()||track.is_none(){
                        let error="missing MoTeC manifest metadata".to_owned();
                        errors.push(json!({"name":name,"error":error}));
                        skipped.push(json!({"name":name,"reason":"missing MoTeC manifest metadata"}));
                        continue;
                    }
                    obj.insert("gameId".into(),json!(game.unwrap()));
                    obj.insert("carOrdinal".into(),json!(car.unwrap()));
                    obj.insert("trackOrdinal".into(),json!(track.unwrap()));
                    super::motec::member(operation,&bytes,&name,&member_options,out,config)
                        .map(|mut value|{if let Some(obj)=value.as_object_mut(){obj.insert("archiveEntry".into(),entry.clone());}value})
                }
                None=>{
                    let error="missing MoTeC manifest metadata".to_owned();
                    errors.push(json!({"name":name,"error":error}));
                    skipped.push(json!({"name":name,"reason":"missing MoTeC manifest metadata"}));
                    continue;
                }
            }
        }else{
            (||{
                let plain = prepare_import_bytes(&bytes)?;
                let (has_records, detected_game) = sniff_import_bytes(&plain)?;
                if !has_records { return Err("Unsupported or empty capture format".into()); }
                let game=detected_game.ok()
                    .or_else(||entry.and_then(|value|value.get("gameId")).and_then(Value::as_str).filter(|id|known_game(id)).map(str::to_owned))
                    .or_else(||game_from_filename(&name).map(str::to_owned))
                    .ok_or("could not determine which game this capture came from")?;
                let mut member_options=options.clone();
                let Some(obj)=member_options.as_object_mut() else{return Err("Import options must be an object".into())};
                obj.insert("gameId".into(),json!(game));
                let mut value=process_plain_bytes(operation,&plain,&game,&name,&member_options,out,config)?;
                if let Some(obj)=value.as_object_mut(){if let Some(entry)=entry{obj.insert("archiveEntry".into(),entry.clone());}}
                Ok(value)
            })()
        };
        match result{
            Ok(value)=>members.push(value),
            Err(error)=>{
                skipped.push(json!({"name":name,"reason":error}));
                errors.push(json!({"name":name,"error":error}));
            }
        }
    }
    let mut result=json!({"version":1,"kind":"archive","originalName":original_name});
    let fields=result.as_object_mut().unwrap();
    fields.insert("archiveManifest".into(),manifest.unwrap_or(Value::Null));
    fields.insert("members".into(),Value::Array(members));
    fields.insert("errors".into(),Value::Array(errors));
    fields.insert("skipped".into(),Value::Array(skipped));
    Ok(result)
}

fn supported_capture_name(name:&str)->bool{name.ends_with(".bin")||name.ends_with(".bin.gz")||name.ends_with(".motec.zip")}
fn known_game(game:&str)->bool{matches!(game,"fm-2023"|"f1-2025"|"acc"|"ac-evo"|"iracing"|"lmu")}
fn game_from_filename(name:&str)->Option<&'static str>{
    const GAMES:[&str;6]=["fm-2023","f1-2025","acc","ac-evo","iracing","lmu"];
    let file=name.rsplit('/').next().unwrap_or(name);
    GAMES.iter().copied().filter(|game|file.strip_prefix(*game).is_some_and(|suffix|suffix.starts_with('-')||suffix.starts_with('_'))).max_by_key(|game|game.len())
}

pub(super) fn prepare_import_bytes(bytes: &[u8]) -> Result<std::borrow::Cow<'_, [u8]>, String> {
    if !bytes.starts_with(&[0x1f, 0x8b]) { return Ok(std::borrow::Cow::Borrowed(bytes)); }
    let decoder = flate2::read::MultiGzDecoder::new(bytes);
    let mut plain = Vec::new();
    decoder.take(1024 * 1024 * 1024 + 1).read_to_end(&mut plain)
        .map_err(|e| format!("Decompress capture: {e}"))?;
    if plain.len() as u64 > 1024 * 1024 * 1024 {
        return Err("Capture exceeds 1 GiB decompressed limit".into());
    }
    Ok(std::borrow::Cow::Owned(plain))
}

pub(super) enum ImportDecoder<'a> {
    Canonical(crate::formats::RecordDecoder<'a>),
    Legacy { bytes: &'a [u8], at: usize, declared: usize, seen: usize },
}
impl<'a> ImportDecoder<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Result<Self, String> {
        let version = if bytes.starts_with(b"IRIQDMP\0") { Some(2) }
            else if bytes.starts_with(b"LMUQDMP\0") { Some(1) }
            else if bytes.starts_with(b"ACCTEST\0") {
                let version = read_u32(bytes, 8).ok_or("Truncated ACCTEST header")?;
                if version != 2 && version != 3 { return Err("Unsupported ACCTEST version".into()); }
                Some(version)
            } else { None };
        if let Some(version) = version {
            if bytes.len() < 16 { return Err("Truncated legacy dump header".into()); }
            if read_u32(bytes, 8) != Some(version) { return Err("Unsupported legacy dump version".into()); }
            Ok(Self::Legacy { bytes, at: 16, declared: read_u32(bytes, 12).unwrap_or(0) as usize, seen: 0 })
        } else { Ok(Self::Canonical(crate::formats::RecordDecoder::new(bytes))) }
    }
    pub(super) fn next(&mut self) -> Result<Option<crate::formats::SourceRecordView<'_>>, String> {
        match self {
            Self::Canonical(decoder) => decoder.next(),
            Self::Legacy { bytes, at, declared, seen } => {
                if *at + 5 > bytes.len() || (*declared != 0 && *seen >= *declared) { return Ok(None); }
                let kind = bytes[*at];
                let len = read_u32(bytes, *at + 1).unwrap_or(0) as usize;
                let payload_at = *at + 5;
                let Some(end) = payload_at.checked_add(len).filter(|end| kind == 0 && len > 0
                    && len <= 16 * 1024 * 1024 && *end <= bytes.len()) else {
                    *at = bytes.len();
                    return Ok(None);
                };
                *at = end;
                *seen += 1;
                Ok(Some(crate::formats::SourceRecordView { offset: payload_at as u64, time_ms: None,
                    kind: crate::formats::RecordKind::Frame, payload: &bytes[payload_at..end] }))
            }
        }
    }
}

fn sniff_import_bytes(bytes: &[u8]) -> Result<(bool, Result<String, String>), String> {
    let mut decoder = ImportDecoder::new(bytes)?;
    let mut sniffer = super::capture::GameSniffer::new();
    let mut count = 0;
    let mut has_records = false;
    while count < 20 {
        let Some(record) = decoder.next()? else { break; };
        has_records = true;
        if record.kind == crate::formats::RecordKind::Frame { count += 1; }
        sniffer.feed(record);
    }
    Ok((has_records, sniffer.finish()))
}

fn process_plain_bytes(operation: &str, bytes: &[u8], game: &str, name: &str,
    options: &Value, out: &Path, config: &Value) -> Result<Value, String> {
    let mut decoder = ImportDecoder::new(bytes)?;
    if decoder.next()?.is_none() { return Err("Unsupported or empty capture format".into()); }
    decoder = ImportDecoder::new(bytes)?;
    super::capture::process_source(operation, game, name, options, out, config, |consume| {
        while let Some(record) = decoder.next()? {
            consume(record)?;
        }
        Ok(())
    })
}

pub(super) fn capture_bytes(operation: &str, bytes: &[u8], name: &str,
    options: &Value, out: &Path, config: &Value) -> Result<Value, String> {
    let plain = prepare_import_bytes(bytes)?;
    let game = options.get("gameId").and_then(Value::as_str)
        .or_else(|| options.get("game").and_then(Value::as_str)).map(str::to_owned);
    let game = if let Some(game) = game { game } else {
        let (has_records, game) = sniff_import_bytes(&plain)?;
        if !has_records { return Err("Unsupported or empty capture format".into()); }
        game?
    };
    process_plain_bytes(operation, &plain, &game, name, options, out, config)
}
/// Benchmarks use the same lending decoder and detection callback as imports.
pub(super) fn benchmark_bytes(bytes: &[u8], game_id: &str) -> Result<Value, String> {
    capture_bytes("benchmark", bytes, "memory-benchmark", &json!({"gameId":game_id}),
        Path::new(""), &Value::Null)
}

fn read_u32(bytes:&[u8],at:usize)->Option<u32>{Some(u32::from_le_bytes(bytes.get(at..at+4)?.try_into().ok()?))}
fn validate_zip_container(path:&Path)->Result<(),String>{
    let mut file=File::open(path).map_err(|e|format!("Open ZIP container: {e}"))?;
    let len=file.metadata().map_err(|e|e.to_string())?.len();
    let window=len.min(65_557);
    file.seek(SeekFrom::End(-(window as i64))).map_err(|e|e.to_string())?;
    let mut bytes=vec![0;window as usize];
    file.read_exact(&mut bytes).map_err(|e|e.to_string())?;
    let signature=[0x50,0x4b,0x05,0x06];
    let eocd=(0..=bytes.len().saturating_sub(22)).rev().find(|&i|bytes.get(i..i+4)==Some(&signature))
        .ok_or("ZIP end-of-central-directory record missing")?;
    let tail=bytes.len()-eocd;
    let comment=u16::from_le_bytes(bytes[eocd+20..eocd+22].try_into().unwrap()) as usize;
    if tail!=22+comment{return Err("Malformed ZIP end-of-central-directory record".into());}
    let disk=u16::from_le_bytes(bytes[eocd+4..eocd+6].try_into().unwrap());
    let central_disk=u16::from_le_bytes(bytes[eocd+6..eocd+8].try_into().unwrap());
    let disk_entries=u16::from_le_bytes(bytes[eocd+8..eocd+10].try_into().unwrap());
    let entries=u16::from_le_bytes(bytes[eocd+10..eocd+12].try_into().unwrap());
    let central_size=u32::from_le_bytes(bytes[eocd+12..eocd+16].try_into().unwrap());
    let central_offset=u32::from_le_bytes(bytes[eocd+16..eocd+20].try_into().unwrap());
    if disk!=0||central_disk!=0||disk_entries!=entries{return Err("Multi-disk ZIP archives are unsupported".into());}
    if entries==u16::MAX||central_size==u32::MAX||central_offset==u32::MAX{return Err("ZIP64 archives are unsupported".into());}
    Ok(())
}

#[cfg(test)]
mod decoder_tests {
    use super::*;

    fn legacy(magic: &[u8; 8], version: u32, declared: u32, payloads: &[&[u8]]) -> Vec<u8> {
        let mut bytes = magic.to_vec();
        bytes.extend_from_slice(&version.to_le_bytes());
        bytes.extend_from_slice(&declared.to_le_bytes());
        for payload in payloads {
            bytes.push(0);
            bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            bytes.extend_from_slice(payload);
        }
        bytes
    }

    #[test]
    fn legacy_import_views_keep_payload_offsets_and_declared_count() {
        for (magic, version) in [(b"IRIQDMP\0", 2), (b"LMUQDMP\0", 1), (b"ACCTEST\0", 3)] {
            let bytes = legacy(magic, version, 1, &[&[1, 2, 3], &[4, 5]]);
            let mut decoder = ImportDecoder::new(&bytes).unwrap();
            let record = decoder.next().unwrap().unwrap();
            assert_eq!(record.offset, 21);
            assert_eq!(record.time_ms, None);
            assert_eq!(record.kind, crate::formats::RecordKind::Frame);
            assert_eq!(record.payload, &[1, 2, 3]);
            assert_eq!(record.payload.as_ptr(), bytes[21..].as_ptr());
            assert!(decoder.next().unwrap().is_none());
        }
    }

    #[test]
    fn legacy_zero_count_reads_complete_prefix_and_stops_at_invalid_record() {
        let mut bytes = legacy(b"IRIQDMP\0", 2, 0, &[&[1, 2], &[3]]);
        bytes.extend_from_slice(&[0, 10, 0, 0, 0, 4]);
        let mut decoder = ImportDecoder::new(&bytes).unwrap();
        assert_eq!(decoder.next().unwrap().unwrap().offset, 21);
        assert_eq!(decoder.next().unwrap().unwrap().offset, 28);
        assert!(decoder.next().unwrap().is_none());
        let mut invalid_kind = legacy(b"LMUQDMP\0", 1, 0, &[&[1], &[2]]);
        invalid_kind[22] = 1;
        let mut decoder = ImportDecoder::new(&invalid_kind).unwrap();
        assert!(decoder.next().unwrap().is_some());
        assert!(decoder.next().unwrap().is_none());
    }

    #[test]
    fn legacy_header_errors_remain_exact() {
        assert!(matches!(ImportDecoder::new(b"IRIQDMP\0"), Err(error) if error == "Truncated legacy dump header"));
        assert!(matches!(ImportDecoder::new(b"ACCTEST\0"), Err(error) if error == "Truncated ACCTEST header"));
        let bytes = legacy(b"IRIQDMP\0", 3, 0, &[]);
        assert!(matches!(ImportDecoder::new(&bytes), Err(error) if error == "Unsupported legacy dump version"));
        let bytes = legacy(b"ACCTEST\0", 1, 0, &[]);
        assert!(matches!(ImportDecoder::new(&bytes), Err(error) if error == "Unsupported ACCTEST version"));
        assert_eq!(capture_bytes("benchmark", &[], "empty", &json!({"gameId":"fm-2023"}),
            Path::new(""), &Value::Null).unwrap_err(), "Unsupported or empty capture format");
    }

    #[test]
    fn plain_sources_are_borrowed_and_concatenated_gzip_members_decode_once() {
        use std::io::Write;
        let bytes = legacy(b"IRIQDMP\0", 2, 0, &[&[1, 2], &[3]]);
        let plain = prepare_import_bytes(&bytes).unwrap();
        assert!(matches!(plain, std::borrow::Cow::Borrowed(_)));
        assert_eq!(plain.as_ptr(), bytes.as_ptr());
        let gzip = |part: &[u8]| {
            let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(part).unwrap();
            encoder.finish().unwrap()
        };
        let mut compressed = gzip(&bytes[..20]);
        compressed.extend_from_slice(&gzip(&bytes[20..]));
        let plain = prepare_import_bytes(&compressed).unwrap();
        assert_eq!(plain.as_ref(), bytes);
        let mut decoder = ImportDecoder::new(&plain).unwrap();
        assert_eq!(decoder.next().unwrap().unwrap().payload, &[1, 2]);
        assert_eq!(decoder.next().unwrap().unwrap().payload, &[3]);
        assert!(decoder.next().unwrap().is_none());
        compressed.pop();
        assert!(prepare_import_bytes(&compressed).is_err());
    }
}
