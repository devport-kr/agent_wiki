import { S3Client } from "@aws-sdk/client-s3";

const clients = new Map<string, S3Client>();

export function getS3Client(region: string): S3Client {
  const existing = clients.get(region);
  if (existing) return existing;

  const client = new S3Client({ region });
  clients.set(region, client);
  return client;
}

export function buildS3Key(prefix: string, localRelativePath: string): string {
  const normalized = localRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!prefix) return normalized;
  const cleanPrefix = prefix.replace(/\/+$/, "");
  return `${cleanPrefix}/${normalized}`;
}
