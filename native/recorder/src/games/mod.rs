pub mod catalog;
mod f1;
mod fm;
pub(crate) mod iracing;
pub(crate) mod lmu;
pub(crate) mod kunos;
pub(crate) mod generated {
    pub(crate) mod layouts {
        include!("generated/layouts.rs");
    }
}

use serde_json::Value;

pub enum DetectionPacket<'a> {
    Ordinal(crate::detection::ordinal::F1Snapshot),
    Kunos(kunos::DetectionInput<'a>),
    IRacing(crate::detection::iracing::IRacingInput),
    Full(Value),
}

/// Stateful canonical source parser. Each source owns one parser instance.
pub struct GameParser {
    game_id: String,
    fm: fm::ForzaParser,
    f1: f1::Parser,
    iracing: iracing::Parser,
    lmu: lmu::LmuParser,
    kunos: Option<kunos::Parser>,
}

impl GameParser {
    pub fn new(game_id: &str) -> Result<Self, String> {
        if !matches!(game_id, "fm-2023" | "f1-2025" | "acc" | "ac-evo" | "iracing" | "lmu") {
            return Err(format!("unsupported game id: {game_id}"));
        }
        let kunos = if matches!(game_id, "acc" | "ac-evo") { Some(kunos::Parser::new(game_id)?) } else { None };
        Ok(Self { game_id: game_id.to_owned(), fm: fm::ForzaParser, f1: f1::Parser::new(), iracing: iracing::Parser::new(), lmu: lmu::LmuParser::new(), kunos })
    }

    /// Consume game-specific bytes produced at source: raw FM/F1 UDP, packed
    /// Kunos triplets, or versioned iRacing/LMU source frames.
    pub fn feed(&mut self, frame: &[u8], time_ms: u64) -> Result<Option<Value>, String> {
        match self.game_id.as_str() {
            "fm-2023" => self.fm.feed(frame),
            "f1-2025" => self.f1.feed(frame),
            "acc" | "ac-evo" => self.kunos.as_mut().unwrap().feed(frame, time_ms),
            "iracing" => self.iracing.feed(frame, time_ms),
            "lmu" => self.lmu.feed(frame, time_ms),
            _ => Err(format!("unsupported game id: {}", self.game_id)),
        }
    }

    /// Imports need detector state, not the complete presentation telemetry tree.
    pub fn feed_for_detection<'a>(&'a mut self, frame: &'a [u8], time_ms: u64) -> Result<Option<DetectionPacket<'a>>, String> {
        match self.game_id.as_str() {
            "f1-2025" => self.f1.feed_for_detection(frame),
            "acc" | "ac-evo" => self.kunos.as_mut().unwrap().feed_for_detection(frame, time_ms)
                .map(|packet| packet.map(DetectionPacket::Kunos)),
            "iracing" => self.iracing.feed_typed(frame, time_ms)
                .map(|packet| packet.map(DetectionPacket::IRacing)),
            _ => self.feed(frame, time_ms).map(|packet| packet.map(DetectionPacket::Full)),
        }
    }

    pub fn reset(&mut self) {
        self.fm.reset(); self.f1.reset(); self.iracing.reset(); self.lmu.reset();
        if let Some(parser)=self.kunos.as_mut(){parser.reset();}
    }
}
