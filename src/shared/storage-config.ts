export type StorageBackend = "local" | "s3" | "hybrid";

export interface StorageConfig {
  backend: StorageBackend;
  bucket: string | undefined;
  region: string | undefined;
  prefix: string;
}

export function loadStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const backendRaw = env["DEVPORT_SNAPSHOT_BACKEND"] ?? "local";
  const backend: StorageBackend =
    backendRaw === "s3" || backendRaw === "hybrid" || backendRaw === "local"
      ? backendRaw
      : "local";

  const bucket = env["DEVPORT_S3_BUCKET"] || undefined;
  const region = env["DEVPORT_S3_REGION"] || undefined;
  const prefix = env["DEVPORT_S3_PREFIX"] ?? "";

  if (backend !== "local" && (!bucket || !region)) {
    throw new Error(
      `DEVPORT_SNAPSHOT_BACKEND=${backend} requires DEVPORT_S3_BUCKET and DEVPORT_S3_REGION to be set`,
    );
  }

  return { backend, bucket, region, prefix };
}
