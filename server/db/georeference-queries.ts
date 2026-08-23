import { and, desc, eq, like } from "drizzle-orm";
import { db } from "./index";
import { georeferenceReferences, georeferenceTransforms } from "./schema";

export interface GeodeticReferencePoint {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeM: number;
}

export interface GeodeticReferenceRecord {
  id: number;
  canonicalSlug: string;
  sourceIdentity: string;
  referenceVersion: string;
  referencePath: readonly GeodeticReferencePoint[];
  originLatitudeDeg: number;
  originLongitudeDeg: number;
  originAltitudeM: number;
  sampleCount: number;
  qualityRmseM: number;
}

export interface GeodeticTransformRecord {
  id: number;
  canonicalSlug: string;
  targetGameId: string;
  targetTrackOrdinal: number;
  sourceIdentity: string;
  referenceVersion: string;
  scale: number;
  rotation: number;
  flipX: boolean;
  flipZ: boolean;
  translationEastM: number;
  translationNorthM: number;
  rmseM: number;
  quality: number;
  sampleCount: number;
}

export async function getGeoreferenceReference(canonicalSlug: string, sourceIdentity: string): Promise<GeodeticReferenceRecord | null> {
  const row = await db
    .select()
    .from(georeferenceReferences)
    .where(and(eq(georeferenceReferences.canonicalSlug, canonicalSlug), eq(georeferenceReferences.sourceIdentity, sourceIdentity)))
    .get();
  return row
    ? {
        ...row,
        referencePath: row.referencePath as readonly GeodeticReferencePoint[],
      }
    : null;
}

export async function getLatestGeoreferenceReference(canonicalSlug: string): Promise<GeodeticReferenceRecord | null> {
  const row = await db
    .select()
    .from(georeferenceReferences)
    .where(and(eq(georeferenceReferences.canonicalSlug, canonicalSlug), like(georeferenceReferences.sourceIdentity, "iracing-track:%")))
    .orderBy(desc(georeferenceReferences.updatedAt), desc(georeferenceReferences.id))
    .get();
  return row
    ? {
        ...row,
        referencePath: row.referencePath as readonly GeodeticReferencePoint[],
      }
    : null;
}

export async function saveGeoreferenceReference(input: Omit<GeodeticReferenceRecord, "id">): Promise<GeodeticReferenceRecord> {
  await db
    .insert(georeferenceReferences)
    .values(input)
    .onConflictDoUpdate({
      target: [georeferenceReferences.canonicalSlug, georeferenceReferences.sourceIdentity],
      set: {
        referenceVersion: input.referenceVersion,
        referencePath: input.referencePath,
        originLatitudeDeg: input.originLatitudeDeg,
        originLongitudeDeg: input.originLongitudeDeg,
        originAltitudeM: input.originAltitudeM,
        sampleCount: input.sampleCount,
        qualityRmseM: input.qualityRmseM,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
  const saved = await getGeoreferenceReference(input.canonicalSlug, input.sourceIdentity);
  if (!saved) throw new Error("Unable to persist georeference reference");
  return saved;
}

export async function getGeoreferenceTransform(canonicalSlug: string, targetGameId: string, targetTrackOrdinal: number, referenceVersion: string): Promise<GeodeticTransformRecord | null> {
  const row = await db
    .select()
    .from(georeferenceTransforms)
    .where(
      and(
        eq(georeferenceTransforms.canonicalSlug, canonicalSlug),
        eq(georeferenceTransforms.targetGameId, targetGameId),
        eq(georeferenceTransforms.targetTrackOrdinal, targetTrackOrdinal),
        eq(georeferenceTransforms.referenceVersion, referenceVersion),
      ),
    )
    .orderBy(desc(georeferenceTransforms.id))
    .get();
  return row ?? null;
}

export async function saveGeoreferenceTransform(input: Omit<GeodeticTransformRecord, "id">): Promise<GeodeticTransformRecord> {
  await db
    .insert(georeferenceTransforms)
    .values(input)
    .onConflictDoUpdate({
      target: [georeferenceTransforms.canonicalSlug, georeferenceTransforms.targetGameId, georeferenceTransforms.targetTrackOrdinal, georeferenceTransforms.referenceVersion],
      set: {
        sourceIdentity: input.sourceIdentity,
        scale: input.scale,
        rotation: input.rotation,
        flipX: input.flipX,
        flipZ: input.flipZ,
        translationEastM: input.translationEastM,
        translationNorthM: input.translationNorthM,
        rmseM: input.rmseM,
        quality: input.quality,
        sampleCount: input.sampleCount,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
  const saved = await getGeoreferenceTransform(input.canonicalSlug, input.targetGameId, input.targetTrackOrdinal, input.referenceVersion);
  if (!saved) throw new Error("Unable to persist georeference transform");
  return saved;
}
