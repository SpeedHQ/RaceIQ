use serde_json::Value;

const CATALOGS: &str = include_str!("generated/catalogs.json");
static CATALOG_DATA:std::sync::LazyLock<Value>=std::sync::LazyLock::new(||serde_json::from_str(CATALOGS).expect("generated game catalogs"));
const LAYOUTS: &str = include_str!("generated/layouts.json");
static LAYOUT_DATA:std::sync::LazyLock<Value>=std::sync::LazyLock::new(||serde_json::from_str(LAYOUTS).expect("generated game layouts"));

pub fn layout(game: &str) -> Option<&'static Value> { LAYOUT_DATA.get(game) }
pub fn layout_number(game:&str,group:&str,key:&str)->Option<usize>{
    LAYOUT_DATA.get(game)?.get(group)?.get(key)?.as_u64().map(|value|value as usize)
}
pub fn layout_constant(game:&str,key:&str)->Option<usize>{
    LAYOUT_DATA.get(game)?.get(key)?.as_u64().map(|value|value as usize)
}
pub fn game(game_id: &str) -> Option<&'static Value> {
    let key = match game_id { "fm-2023"=>"fm", "f1-2025"=>"f1", "acc"=>"acc", "ac-evo"=>"evo", "iracing"=>"iracing", "lmu"=>"lmu", _=>return None };
    CATALOG_DATA.get(key)
}
fn lmu_model_alias(name:&str)->String{
    let name=name.trim();
    if let Some((base,year))=name.rsplit_once(char::is_whitespace){
        if year.len()==4&&year.bytes().all(|b|b.is_ascii_digit()){return base.to_owned();}
    }
    name.to_owned()
}


/// Resolve catalog entry by exact stable ordinal/ID or case-insensitive display
/// name. Source-specific resolvers should apply their aliases before this lookup.
pub fn resolve(game_id: &str, section: &str, key: &str, value: &str) -> Option<Value> {
    let catalog = game(game_id)?;
    let entries = catalog.get(section)?.as_array()?;
    entries.iter().find(|entry| {
        let obj=entry.as_object().unwrap();
        obj.get(key).and_then(Value::as_str).map(|v|v==value).unwrap_or(false)
            || obj.get(key).and_then(Value::as_i64).map(|v|v.to_string()==value).unwrap_or(false)
            || obj.get("name").and_then(Value::as_str).map(|v|v.eq_ignore_ascii_case(value)).unwrap_or(false)
            || obj.get("model").and_then(Value::as_str).map(|v|v.eq_ignore_ascii_case(value)).unwrap_or(false)
    }).cloned()
}

fn normalized(value: &str) -> String { value.trim().to_lowercase() }

fn tier_candidates(entries: &[Value], values: &[&str], aliases: impl Fn(&Value)->Vec<String>) -> Option<Value> {
    let mut found = false;
    let mut candidates = Vec::<Value>::new();
    for value in values.iter().filter(|v| !v.trim().is_empty()) {
        let needle=normalized(value);
        let matches: Vec<Value>=entries.iter().filter(|entry|aliases(entry).iter().any(|a|normalized(a)==needle)).cloned().collect();
        if matches.is_empty(){continue;}
        found=true;
        for item in matches { if !candidates.contains(&item){candidates.push(item);} }
    }
    if found && candidates.len()==1 {Some(candidates.remove(0))} else if found {Some(Value::Null)} else {None}
}

/// Port of LMU resolver tiers: exact IDs, vehicle aliases, then year-stripped model names.
pub fn resolve_lmu_car(car_id: &str, vehicle_name: &str) -> Option<Value> {
    let catalog=game("lmu")?; let entries=catalog.get("cars")?.as_array()?;
    for tier in 0..3 {
        let resolved=tier_candidates(entries,&[car_id,vehicle_name],|entry|{
            let mut out=Vec::new();
            match tier {
                0=>{if let Some(id)=entry.get("id").and_then(Value::as_str){out.push(id.to_owned())}
                    if let Some(variants)=entry.get("variants").and_then(Value::as_array){for v in variants {if let Some(id)=v.get("id").and_then(Value::as_str){out.push(id.to_owned())}}}}
                1=>{if let Some(names)=entry.get("vehicleNames").and_then(Value::as_array){out.extend(names.iter().filter_map(Value::as_str).map(str::to_owned))}
                    if let Some(variants)=entry.get("variants").and_then(Value::as_array){for v in variants {if let Some(n)=v.get("name").and_then(Value::as_str){out.push(n.to_owned())}}}}
                _=>{if let Some(name)=entry.get("name").and_then(Value::as_str){out.push(name.to_owned());out.push(lmu_model_alias(name));}}
            }
            out
        });
        if let Some(value)=resolved {return if value.is_null(){None}else{Some(value)};}
    }
    None
}

/// Port of LMU track-ID/layout lookup followed by display-name lookup.
pub fn resolve_lmu_track(track_ids: &[&str]) -> Option<Value> {
    let catalog=game("lmu")?; let entries=catalog.get("tracks")?.as_array()?;
    for tier in 0..2 {
        let mut sets:Vec<Vec<Value>>=Vec::new();
        for input in track_ids.iter().filter(|s|!s.trim().is_empty()) {
            let needle=normalized(input);
            let matches:Vec<Value>=entries.iter().filter(|entry|{
                let mut aliases=Vec::new();
                if tier==0 {
                    if let Some(id)=entry.get("id").and_then(Value::as_str){aliases.push(id.to_owned());if let Some(last)=id.rsplit('/').next(){aliases.push(last.to_owned());}}
                    if let Some(layout)=entry.get("layout").and_then(Value::as_str){aliases.push(layout.to_owned());}
                } else if let Some(name)=entry.get("name").and_then(Value::as_str){aliases.push(name.to_owned());}
                aliases.iter().any(|a|normalized(a)==needle)
            }).cloned().collect();
            if !matches.is_empty(){sets.push(matches);}
        }
        if sets.is_empty(){continue;}
        let common:Vec<Value>=sets[0].iter().filter(|v|sets.iter().skip(1).all(|s|s.contains(v))).cloned().collect();
        return if common.len()==1 {Some(common[0].clone())} else {None};
    }
    None
}

fn kunos_name(value:&str)->String{value.to_lowercase().chars().filter(|c|!matches!(c,'-'|'_'|' ')&&!c.is_whitespace()).collect()}

pub fn resolve_acc_car(model:&str)->Option<Value>{resolve("acc","cars","model",model)}

pub fn resolve_acc_track(name:&str)->Option<Value>{
    let entries=game("acc")?.get("tracks")?.as_array()?;let needle=kunos_name(name);
    entries.iter().find(|entry|entry.get("name").and_then(Value::as_str).map(|v|{let candidate=kunos_name(v);candidate==needle||candidate.contains(&needle)||needle.contains(&candidate)}).unwrap_or(false)).cloned()
}

pub fn resolve_evo_car(display_name:&str)->Option<Value>{
    let entries=game("ac-evo")?.get("cars")?.as_array()?;let needle=display_name.to_lowercase().trim().to_owned();
    entries.iter().find(|entry|entry.get("name").and_then(Value::as_str).map(|s|s.to_lowercase()==needle).unwrap_or(false)).cloned().or_else(||{
        let compact=|s:&str|s.to_lowercase().chars().filter(|c|!matches!(c,'-'|'_')&&!c.is_whitespace()).collect::<String>();let target=compact(display_name);if target.is_empty(){return None;}
        entries.iter().find(|entry|["name","model"].iter().any(|k|entry.get(*k).and_then(Value::as_str).map(|s|compact(s)==target).unwrap_or(false))).cloned()
    })
}

pub fn resolve_evo_track(name:&str,config:&str)->Option<Value>{
    let entries=game("ac-evo")?.get("tracks")?.as_array()?;let needle=kunos_name(name);if needle.is_empty(){return None;}
    let find_exact=|needle:&str|entries.iter().find(|entry|{
        ["commonTrackName","name"].iter().any(|k|entry.get(*k).and_then(Value::as_str).map(|s|kunos_name(s)==needle).unwrap_or(false))
            || {let n=entry.get("name").and_then(Value::as_str).unwrap_or("");let variant=entry.get("variant").and_then(Value::as_str).unwrap_or("");kunos_name(&format!("{n}{variant}"))==needle}
    }).cloned();
    if !config.is_empty(){let combined=kunos_name(&format!("{name}{config}"));if combined!=needle {if let Some(v)=find_exact(&combined){return Some(v);}}}
    if let Some(v)=find_exact(&needle){return Some(v);}
    let mut best=None;let mut best_len=0;
    for entry in entries {for key in ["commonTrackName","name"] {if let Some(value)=entry.get(key).and_then(Value::as_str){let candidate=kunos_name(value);if !candidate.is_empty()&&(candidate.contains(&needle)||needle.contains(&candidate)){let len=candidate.len().min(needle.len());if len>best_len {best=Some(entry.clone());best_len=len;}}}}}
    best
}
