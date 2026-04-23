# RaceIQ Architecture

Visual architecture diagrams for the RaceIQ racing telemetry platform.

## System Overview

```mermaid
graph TB
    subgraph Games["Racing Games"]
        FM[Forza Motorsport]
        F1[F1 2025]
        ACC[Assetto Corsa Competizione]
        ACEVO[Assetto Corsa Evo]
    end

    subgraph Server["Server (Bun + Hono)"]
        UDP[UDP Listener<br/>64MB buffer]
        SHM[Shared Memory Reader<br/>Windows only]
        Parser[Parser Dispatch<br/>Auto-detect game]
        Pipeline[Telemetry Pipeline<br/>Normalize → Detect → Track → Calibrate → Broadcast]
        LapDet[Lap Detector<br/>Per-game factory]
        SectorTrack[Sector Tracker]
        PitTrack[Pit Tracker]
        TrackCal[Track Calibration<br/>~10Hz outline refinement]
        WS[WebSocket Manager<br/>30Hz throttled broadcast]
        API[Hono REST API<br/>12 route modules]
        DB[(SQLite + Drizzle)]
        AI[AI Analysis<br/>Mastra agents + Claude API]
    end

    subgraph Client["Client (React 19 + Vite)"]
        Router[TanStack Router]
        TelStore[Telemetry Store<br/>Zustand]
        GameStore[Game Store<br/>Zustand]
        UIStore[UI Store<br/>Zustand]
        Query[TanStack Query]
        UI[Dashboard Components]
    end

    FM -- "UDP :5300" --> UDP
    F1 -- "UDP :5300" --> UDP
    ACC -- "Shared Memory" --> SHM
    ACEVO -- "Shared Memory" --> SHM

    UDP --> Parser
    SHM --> Parser
    Parser --> Pipeline
    Pipeline --> LapDet
    Pipeline --> SectorTrack
    Pipeline --> PitTrack
    Pipeline --> TrackCal
    Pipeline --> WS
    LapDet -- "Save laps" --> DB
    WS -- "WebSocket :3117/ws" --> TelStore
    API -- "HTTP :3117/api" --> Query
    API --> DB
    API --> AI
    TelStore --> UI
    GameStore --> UI
    UIStore --> UI
    Query --> UI
    Router --> UI
```

## Telemetry Data Flow

```mermaid
sequenceDiagram
    participant Game as Racing Game
    participant UDP as UDP Listener
    participant Parse as Parser Dispatch
    participant Pipe as Pipeline
    participant Lap as Lap Detector
    participant Sector as Sector Tracker
    participant Pit as Pit Tracker
    participant Cal as Track Calibration
    participant WS as WebSocket Manager
    participant Client as React Client

    Game->>+UDP: Binary UDP packet (60Hz)
    UDP->>UDP: Validate (≥29 bytes)
    UDP->>+Parse: parsePacket(buffer)
    Parse->>Parse: cachedGame.canHandle()?
    alt Cache hit
        Parse->>Parse: cachedGame.tryParse(buf, state)
    else Cache miss
        Parse->>Parse: Probe all adapters
    end
    Parse-->>-UDP: TelemetryPacket | null

    UDP->>+Pipe: processPacket(packet)
    Pipe->>Pipe: Normalize coordinates
    Pipe->>Pipe: Fill suspension values
    Pipe->>Lap: detectLap(packet)
    Lap-->>Pipe: Lap boundary?

    alt Lap completed
        Lap->>Lap: Save to SQLite
    end

    Pipe->>Sector: trackSectors(packet)
    Pipe->>Pit: trackPitLane(packet)
    Pipe->>Cal: calibrate(packet) ~10Hz

    Pipe->>+WS: broadcast(packet, sectors, pit)
    WS->>WS: Sample history (10Hz)
    WS->>WS: Throttle (30Hz)
    WS-->>-Client: JSON via WebSocket
    Client->>Client: Zustand store update
    Client->>Client: React re-render
```

## Data Ingest Pipeline (Detail)

```mermaid
flowchart TD
    subgraph Ingestion["Packet Ingestion"]
        UDP["UDP Socket<br/>0.0.0.0:5301<br/>64MB OS buffer"]
        SHM["ACC Shared Memory<br/>Windows only<br/>Physics + Graphics + Static"]
        Val{"≥29 bytes?<br/>IsRaceOn == 1?"}
    end

    subgraph Recording["Per-Session Recording"]
        Rec["SessionRecorder<br/>data/sessions/&lt;gameId&gt;/&lt;ts&gt;.bin<br/>[12B meta frame][uint32 len][N bytes]...<br/>rawByteOffset stamped per lap"]
    end

    subgraph Parsing["Parser Dispatch"]
        Cache{"Cached game<br/>adapter?"}
        Probe["Probe all adapters<br/>canHandle(buf)"]
        RunCheck["getRunningGame()<br/>Process detection<br/>Every 5s"]
        Parse["tryParse(buf, state)<br/>Game-specific parser"]
    end

    subgraph Pipeline["processPacket() Pipeline"]
        Norm["1. Coordinate Normalization<br/>ACC: flip X for left-handed display"]
        Susp["2. Suspension Fill<br/>Compute NormSuspensionTravel<br/>for F1/ACC"]
        LD["3. Lap Detector<br/>Session + lap boundaries<br/>Rewind detection"]
        ST["4. Sector Tracker<br/>Distance-fraction splits<br/>Estimated lap time vs reference"]
        PT["5. Pit Tracker<br/>Fuel rolling avg (5 laps)<br/>Tire wear interpolation"]
        TC["6. Track Calibration ~10Hz<br/>Procrustes alignment<br/>Forza coords ↔ outline coords"]
        BC["7. WebSocket Broadcast<br/>30Hz throttle, 10Hz history sampling"]
        Dev["8. Dev State Broadcast<br/>Debug overlay data"]
    end

    subgraph LapDetect["Lap Detection State Machine"]
        SessStart["Session Start<br/>Car/track change or 30s gap"]
        LapBound["Lap Boundary<br/>LapNumber increment or<br/>CurrentLap timer reset"]
        Quality["Lap Quality Check<br/>≥30 packets, ≥100m distance<br/>±2s time match, no rewind"]
        Save["Save lap row<br/>rawByteOffset + rawFrameCount<br/>(telemetry re-parsed on demand)"]
    end

    subgraph SectorDetail["Sector Tracking"]
        DistFrac["Distance fraction<br/>= (dist - lapStart) / totalDist"]
        SplitCalc["Live split times<br/>packet.CurrentLap - sectorStart"]
        RefLap["Reference lap interpolation<br/>Binary search + linear interp"]
        EstLap["Estimated lap time<br/>bestLap + (liveTime - refTime)"]
    end

    subgraph PitDetail["Pit Strategy"]
        FuelAvg["Fuel: rolling avg 5 laps<br/>Outlier rejection (refuel ignored)"]
        TireWear["Tires: distance-based interp<br/>Avg of 3 laps wear curve"]
        Outlier["Reject: >2x avg duration (pit/SC)<br/><30% avg duration (cut/rewind)"]
    end

    subgraph Persist["Persistence"]
        DB[(SQLite<br/>sessions, laps,<br/>trackOutlines)]
        WS["WebSocket Clients<br/>30Hz JSON stream<br/>+ 600-sample history backfill"]
    end

    UDP --> Val
    SHM --> Val
    Val -- No --> Drop[Drop packet]
    Val -- Yes --> Cache

    Val -. "--record mode" .-> Rec

    Cache -- Hit --> Parse
    Cache -- Miss --> RunCheck
    RunCheck -- Found --> Parse
    RunCheck -- Not found --> Probe
    Probe -- Match --> Parse
    Probe -- None --> Drop

    Parse -- "TelemetryPacket" --> Norm
    Norm --> Susp
    Susp --> LD
    LD --> ST
    ST --> PT
    PT --> TC
    TC --> BC
    BC --> Dev

    LD --> LapDetect
    SessStart --> LapBound
    LapBound --> Quality
    Quality -- Valid --> Save
    Quality -- Invalid --> Save

    ST --> SectorDetail
    DistFrac --> SplitCalc
    SplitCalc --> RefLap
    RefLap --> EstLap

    PT --> PitDetail
    FuelAvg --> Outlier
    TireWear --> Outlier

    Save --> DB
    BC --> WS
```

### Pipeline Adapters (Testability)

The pipeline uses dependency injection for DB and WebSocket access:

| Interface | Production | Test |
|-----------|-----------|------|
| `DbAdapter` | `RealDbAdapter` — SQLite queries | `NullDbAdapter`, `CapturingDbAdapter` |
| `WsAdapter` | `RealWsAdapter` — Bun WebSocket manager | `NullWsAdapter`, `CapturingWsAdapter` |

### Pipeline Callbacks

| Event | Trigger | Payload |
|-------|---------|---------|
| `onSessionStart` | Car/track change or 30s silence | `SessionState` |
| `onLapComplete` | Lap boundary crossed | `packets[], lapTime, isValid` |
| `onLapSaved` | Lap persisted to DB | `lapId, lapNumber, lapTime, sectors` |

## Game Adapter Pattern

```mermaid
classDiagram
    class GameAdapter {
        <<interface>>
        +id: GameId
        +displayName: string
        +shortName: string
        +routePrefix: string
        +coordSystem: string
        +steeringCenter: number
        +steeringRange: number
        +carForwardOffset(yaw) [dx, dz]
        +followViewRotation(yaw) number
        +tireHealthThresholds: green, yellow
        +tireTempThresholds: cold, warm, hot
        +tirePressureOptimal?: min, max
        +brakeTempThresholds?: front, rear
        +getCarName(ordinal) string
        +getTrackName(ordinal) string
        +getSharedTrackName(ordinal) string?
        +carClassNames?: Record
        +drivetrainNames?: Record
    }

    class ServerGameAdapter {
        <<interface>>
        +canHandle(buf) boolean
        +tryParse(buf, state) TelemetryPacket?
        +createParserState() unknown
        +createLapDetector: LapDetectorFactory
        +aiSystemPrompt: string
        +buildAiContext(packets) string?
        +processNames?: string[]
    }

    GameAdapter <|-- ServerGameAdapter

    class ForzaAdapter {
        id = "fm-2023"
        coordSystem = "forza-lhz"
        steeringCenter = 127
        Stateless parser
        Size-based detection
    }

    class F1Adapter {
        id = "f1-2025"
        coordSystem = "standard-xyz"
        steeringCenter = 0
        Stateful accumulator
        Magic-bytes detection
    }

    class ACCAdapter {
        id = "acc"
        coordSystem = "standard-xyz"
        steeringCenter = 0
        Shared memory reader
        Windows process detection
    }

    class AcEvoAdapter {
        id = "ac-evo"
        coordSystem = "standard-xyz"
        steeringCenter = 0
        v0.6 shared memory (acevo_pmf_*)
        Reuses ACC triplet pipeline
        Tracks mapped to ACC outlines (X-flipped)
    }

    ServerGameAdapter <|.. ForzaAdapter
    ServerGameAdapter <|.. F1Adapter
    ServerGameAdapter <|.. ACCAdapter
    ServerGameAdapter <|.. AcEvoAdapter

    class SharedRegistry {
        -games: Map~GameId, GameAdapter~
        +registerGame(adapter)
        +getGame(id) GameAdapter
        +tryGetGame(id) GameAdapter?
        +getAllGames() GameAdapter[]
    }

    class ServerRegistry {
        -games: Map~GameId, ServerGameAdapter~
        +registerServerGame(adapter)
        +getServerGame(id) ServerGameAdapter
        +getAllServerGames() ServerGameAdapter[]
        +tryGetServerGame(id) ServerGameAdapter?
        +isGameRunning() boolean
        +getRunningGame() ServerGameAdapter?
    }

    SharedRegistry --> GameAdapter
    ServerRegistry --> ServerGameAdapter
```

## AI Analysis System

```mermaid
graph TB
    subgraph Providers["providers.ts"]
        Claude[Claude API Client<br/>Streaming + Caching]
    end

    subgraph Agents["agents.ts — Mastra Agents"]
        Analyst[Lap Analyst Agent]
        CompareEng[Compare Engineer Agent]
        ChatAgent[Chat Agent<br/>Interactive Q&A]
    end

    subgraph Prompts["System Prompts"]
        AnalystP[analyst-prompt.ts<br/>Lap breakdown]
        ChatP[chat-prompt.ts<br/>Single lap chat]
        CompareP[compare-engineer.ts<br/>Head-to-head]
        CompareChatP[compare-chat-prompt.ts<br/>Comparison chat]
        InputsP[inputs-compare-prompt.ts<br/>Input-focused comparison]
        CornerP[corner-data.ts<br/>Corner-by-corner]
        TuneP[format-tune.ts<br/>Tune recommendations]
    end

    subgraph Cache["Database Cache"]
        LapCache[(lapAnalyses<br/>Per-lap cache)]
        CompCache[(compareAnalyses<br/>Per-pair cache)]
    end

    Providers --> Agents
    AnalystP --> Analyst
    ChatP --> ChatAgent
    CompareP --> CompareEng
    CompareChatP --> ChatAgent
    InputsP --> CompareEng
    CornerP --> Analyst
    TuneP --> Analyst

    Analyst --> LapCache
    CompareEng --> CompCache
```

## Database Schema

```mermaid
erDiagram
    profiles {
        integer id PK
        text name
        text createdAt
    }

    sessions {
        integer id PK
        integer carOrdinal
        integer trackOrdinal
        text gameId
        text sessionType
        text notes
        text rawFile "Absolute path to session .bin/.bin.gz — NULL for pre-migration sessions (drives isLegacy)"
        text lapDetectorVersion "Detector version stamp, used by stale-session UI banner"
        text createdAt
    }

    laps {
        integer id PK
        integer sessionId FK
        integer lapNumber
        real lapTime
        integer isValid
        text invalidReason
        text notes
        integer profileId FK
        integer pi
        text carSetup "JSON — F1CarSetup snapshot"
        integer tuneId FK
        real s1Time
        real s2Time
        real s3Time
        integer rawByteOffset "Byte offset into session.rawFile where this lap's frames start"
        integer rawFrameCount "Frame count for this lap in rawFile"
        text createdAt
    }

    tunes {
        integer id PK
        text name
        text author
        integer carOrdinal
        text category
        integer trackOrdinal
        text description
        text strengths
        text weaknesses
        text bestTracks
        text strategies
        text settings "JSON"
        text unitSystem
        text source
        text catalogId
        text createdAt
        text updatedAt
    }

    tuneAssignments {
        integer id PK
        integer carOrdinal
        integer trackOrdinal
        integer tuneId FK
    }

    trackOutlines {
        integer id PK
        integer trackOrdinal
        text gameId
        blob outline "gzip'd JSON array"
        text sectors "JSON — s1End, s2End"
        text createdAt
    }

    trackCorners {
        integer id PK
        integer trackOrdinal
        text gameId
        integer cornerIndex
        text label
        real distanceStart
        real distanceEnd
        integer isAuto
    }

    lapAnalyses {
        integer id PK
        integer lapId FK "unique"
        text analysis
        integer inputTokens
        integer outputTokens
        real costUsd
        integer durationMs
        text model
        text createdAt
    }

    compareAnalyses {
        integer id PK
        integer lapAId "unique(a, b, kind)"
        integer lapBId
        text kind "default: inputs"
        text analysis
        integer inputTokens
        integer outputTokens
        real costUsd
        integer durationMs
        text model
        text createdAt
    }

    sessions ||--o{ laps : "has"
    profiles ||--o{ laps : "driven by"
    tunes ||--o{ laps : "using"
    tunes ||--o{ tuneAssignments : "assigned"
    laps ||--o| lapAnalyses : "analysed"
```

**Legacy-lap derivation (`isLegacy`):** a lap is "legacy" (pre-raw-binary-storage, telemetry unavailable) iff `sessions.raw_file IS NULL`. Migration 19 added `raw_file` + `raw_byte_offset` together, and `Pipeline.onSessionStart` populates `raw_file` before any lap lands — so it's the reliable signal. Per-lap `raw_byte_offset` can be null on a post-migration session (e.g. import-dump path feeds the pipeline without a `rawBuf`, so the recorder stays inactive for that call) and must not be used as the legacy gate.

## Client Architecture

```mermaid
graph TB
    subgraph Routing["TanStack Router (file-based)"]
        Root["/ — Root Layout"]
        Onboard["Onboarding Wizard<br/>First-run setup"]
        FM23["/fm23 — Forza Motorsport"]
        F125["/f125 — F1 2025"]
        ACCRoute["/acc — ACC"]
        ACEVORoute["/ac-evo — Assetto Corsa Evo"]
        Dev["/dev — Dev Tools"]
    end

    subgraph GamePages["Per-Game Pages (shared structure)"]
        Live["/live — Live Telemetry"]
        Sessions["/sessions — Session History"]
        Compare["/compare — Lap Comparison"]
        Analyse["/analyse — Lap Analysis"]
        Chats["/chats — AI Chat Threads"]
        Tracks["/tracks — Track Maps"]
        Cars["/cars — Car Database"]
        Setup["/setup — Car Setup"]
        Tunes["/tunes — Tune Catalog"]
        Raw["/raw — Raw Telemetry"]
    end

    subgraph State["State Management"]
        TS["telemetry.ts (Zustand)<br/>Live packet, connection, units,<br/>history arrays, server status"]
        GS["game.ts (Zustand)<br/>Active gameId, route prefix"]
        US["ui.ts (Zustand)<br/>Settings modal, onboarding modal"]
        TQ["TanStack Query<br/>Laps, sessions, tracks, tunes,<br/>settings, AI analyses"]
    end

    subgraph Comms["Server Communication"]
        WSC["WebSocket /ws<br/>Live telemetry stream"]
        RPC["Hono RPC client<br/>Typed API calls"]
    end

    Root --> Onboard
    Root --> FM23
    Root --> F125
    Root --> ACCRoute
    Root --> ACEVORoute
    Root --> Dev

    FM23 --> GamePages
    F125 --> GamePages
    ACCRoute --> GamePages
    ACEVORoute --> GamePages

    WSC --> TS
    RPC --> TQ
    TS --> Live
    GS --> Routing
    US --> Root
    TQ --> Sessions
    TQ --> Compare
    TQ --> Analyse
    TQ --> Chats
```

## Server Route Modules

```mermaid
graph LR
    subgraph Routes["routes.ts — Hono App Composition"]
        Laps[lap-routes.ts<br/>Lap CRUD, telemetry, GIF]
        Sessions[session-routes.ts<br/>Session CRUD]
        Tracks[track-routes.ts<br/>Outlines, sectors, corners]
        Cars[car-routes.ts<br/>Car catalog]
        Tunes[tune-routes.ts<br/>Tune management]
        Settings[settings-routes.ts<br/>User preferences]
        ChatsR[chats-routes.ts<br/>AI chat threads]
        ACC[acc-routes.ts<br/>ACC setups, shared memory]
        ACEVOR[ac-evo-routes.ts<br/>AC Evo cars, reader, debug]
        F125R[f125-routes.ts<br/>F1-specific APIs]
        Misc[misc-routes.ts<br/>Export, comparison, status]
        DevR[dev-routes.ts<br/>Debug endpoints, dev only]
    end
```

## Server Startup Sequence

```mermaid
sequenceDiagram
    participant Main as index.ts
    participant GA as Game Adapters
    participant DB as Database
    participant Settings as Settings
    participant HTTP as Bun.serve
    participant UDP as UDP Listener
    participant SHM as Shared Memory
    participant Tray as System Tray

    Main->>Main: process.title = "RaceIQ"
    Main->>GA: initGameAdapters()
    Main->>GA: initServerGameAdapters()
    Main->>DB: Initialize SQLite + run migrations
    Main->>Settings: Load settings.json
    Main->>DB: Clean up empty sessions

    opt macOS
        Main->>Main: Spawn caffeinate -i (prevent sleep)
    end

    Main->>Main: Kill stale processes on HTTP_PORT
    Main->>HTTP: Bun.serve({ port: 3117 })
    Note over HTTP: HTTP + WebSocket upgrade at /ws
    Main->>UDP: udpListener.start(settings.udpPort)
    Note over UDP: 64MB OS receive buffer

    opt Windows
        Main->>SHM: Start ACC + AC Evo shared memory readers
        Main->>Tray: Initialize system tray
    end

    opt First run
        Main->>Main: Open browser to localhost:3117
    end

    opt --record flag
        Main->>Main: Record raw packets to bin file<br/>(bypasses WS + DB pipeline)
    end
```

## Parser Dispatch Strategy

```mermaid
flowchart TD
    A[Incoming UDP Buffer] --> B{Cached game\navailable?}
    B -- Yes --> C{cachedGame\n.canHandle buf?}
    C -- Yes --> D[tryParse with cached state]
    C -- No --> E{Last check\n> 5s ago?}
    E -- Yes --> F[getRunningGame\nprocess detection]
    E -- No --> G[Probe all adapters]
    B -- No --> G
    F --> H{Game found?}
    H -- Yes --> I[Update cache + tryParse]
    H -- No --> G
    G --> J{Any adapter\ncanHandle?}
    J -- Yes --> K[Cache adapter + tryParse]
    J -- No --> L[Drop packet]
    D --> M[TelemetryPacket]
    I --> M
    K --> M
    M --> N[processPacket pipeline]
```

## Comparison Engine

```mermaid
flowchart LR
    A[Lap A telemetry] --> C[Distance-grid alignment<br/>1-meter interpolation]
    B[Lap B telemetry] --> C
    C --> D[AlignedTrace<br/>speed, throttle, brake,<br/>steering, RPM per meter]
    D --> E[Corner deltas]
    D --> F[Sector splits]
    D --> G[AI inputs analysis<br/>cached in compareAnalyses]
```

## ACC + AC Evo Adapter Detail

Both games use shared memory on Windows and the same underlying infrastructure.
AC Evo reuses ACC's `BufferedAccMemoryReader`, `TripletAssembler`, and
`TripletPipeline` — only the memory-map names, struct layouts, process name,
and parser differ.

```mermaid
graph TB
    subgraph Shared["Shared Infra (server/games/acc)"]
        Buf[BufferedAccMemoryReader]
        Trip[TripletPipeline<br/>Multi-packet assembly]
        Asm[TripletAssembler]
    end

    subgraph ACC["ACC Adapter (server/games/acc)"]
        AccProc[Process Checker<br/>acc.exe detection]
        AccSHM[Shared Memory<br/>Local\\acpmf_*]
        AccStructs[ACC Struct Definitions]
        AccParse[ACC Parser]
        AccRec[ACC Recorder<br/>Bin file capture]
        Extract[Track Extractor<br/>Outline from telemetry]
    end

    subgraph ACEVO["AC Evo Adapter (server/games/ac-evo)"]
        EvoProc[Process Checker<br/>AssettoCorsaEVO.exe]
        EvoSHM[Shared Memory<br/>Local\\acevo_pmf_*]
        EvoStructs[v0.6 Struct Definitions]
        EvoParse[AC Evo Parser<br/>CSV-backed car/track resolution]
        EvoRec[AC Evo Recorder<br/>.bin.gz]
    end

    AccProc --> AccSHM
    AccSHM --> Buf
    EvoProc --> EvoSHM
    EvoSHM --> Buf

    Buf --> Trip
    Trip --> Asm
    Asm --> AccParse
    Asm --> EvoParse

    AccStructs -. "layout" .- AccParse
    EvoStructs -. "layout" .- EvoParse

    AccParse --> AccRec
    EvoParse --> EvoRec
    AccSHM --> Extract
```
