import { z } from "zod";
const id=z.string().min(1).max(512);
export const cloudImportAccess=z.object({accountEpoch:id,expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export const cloudImportQuery=z.object({accountEpoch:id,expectedRevision:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export const cloudImportStart=cloudImportAccess.extend({lapId:id,lapGuid:z.string().uuid(),trackId:id,carId:id});
export const cloudImportActivation=cloudImportAccess.extend({activationId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)});
