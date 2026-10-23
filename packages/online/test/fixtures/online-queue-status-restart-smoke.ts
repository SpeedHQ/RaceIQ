import { OnlineStateStorage } from '@raceiq/online/server/state-storage';
import { createRaceIqOnlineService } from '@raceiq/online/server/service';
const dir = process.argv[2];
if (!dir) throw new Error('Missing isolated queue database directory');
process.env.DATA_DIR = dir;
const service = createRaceIqOnlineService({ recordingProducer: async () => { throw new Error("Auth-only fixture must not prepare a recording"); }, storage: new OnlineStateStorage(dir), keystore: { getSecret: async () => '', setSecret: async () => {} }, adapter: { getPolicy: async () => ({ available: true, termsVersion: 'terms-1', privacyVersion: 'privacy-1', termsUrl: 'https://example.com/terms', privacyUrl: 'https://example.com/privacy' }) } });
const state = await service.getState();
console.log(JSON.stringify({ accountEpoch: state.accountEpoch, sync: state.sync }));
