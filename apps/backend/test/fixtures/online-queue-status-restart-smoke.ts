import { OnlineStateStorage } from '@raceiq/online/state-storage';
import { createRaceIqOnlineService } from '@raceiq/online/service';
const dir = process.argv[2];
if (!dir) throw new Error('Missing isolated queue database directory');
process.env.DATA_DIR = dir;
const service = createRaceIqOnlineService({ storage: new OnlineStateStorage(dir), keystore: { getSecret: async () => '', setSecret: async () => {} }, adapter: { getPolicy: async () => ({ available: true, termsVersion: 'terms-1', privacyVersion: 'privacy-1', termsUrl: 'https://example.com/terms', privacyUrl: 'https://example.com/privacy' }) } });
const state = await service.getState();
console.log(JSON.stringify({ accountEpoch: state.accountEpoch, sync: state.sync }));
