import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

export interface S3JsonAdapter {
  readJson(key: string): Promise<unknown | null>;
  writeJson(key: string, body: unknown): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export function isS3NotFound(err: unknown): boolean {
  if (err instanceof Error) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return true;
    const code = (err as { Code?: string }).Code;
    if (code === "NoSuchKey" || code === "NotFound") return true;
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (statusCode === 404) return true;
  }
  return false;
}

export function createS3JsonAdapter(client: S3Client, bucket: string): S3JsonAdapter {
  return {
    async readJson(key: string): Promise<unknown | null> {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        const body = await response.Body?.transformToString("utf8");
        if (!body) return null;
        return JSON.parse(body);
      } catch (err) {
        if (isS3NotFound(err)) return null;
        throw err;
      }
    },

    async writeJson(key: string, body: unknown): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(body, null, 2),
          ContentType: "application/json",
        }),
      );
    },

    async exists(key: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        if (isS3NotFound(err)) return false;
        throw err;
      }
    },
  };
}
