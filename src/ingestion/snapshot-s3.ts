import { promises as fs } from "node:fs";
import path from "node:path";
import * as tar from "tar";
import {
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

import type { GitShell } from "./snapshot";
import { isS3NotFound } from "../shared/s3-storage";

function tarbAllKey(snapshotId: string, prefix: string): string {
  const filename = `snapshots/${snapshotId}.tar.gz`;
  if (!prefix) return filename;
  const cleanPrefix = prefix.replace(/\/+$/, "");
  return `${cleanPrefix}/${filename}`;
}

export class S3SnapshotShell implements GitShell {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
    private readonly fallbackShell: GitShell,
  ) {}

  async materialize({
    repoFullName,
    commitSha,
    snapshotPath,
  }: {
    repoFullName: string;
    commitSha: string;
    snapshotPath: string;
  }): Promise<void> {
    const snapshotId = path.basename(snapshotPath);
    const s3Key = tarbAllKey(snapshotId, this.prefix);

    // Check if tarball exists in S3
    let existsInS3 = false;
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key }),
      );
      existsInS3 = true;
    } catch (err) {
      if (!isS3NotFound(err)) {
        process.stderr.write(
          `[s3] warning: HeadObject failed for ${s3Key}: ${String(err)}\n`,
        );
      }
    }

    if (existsInS3) {
      // Restore from S3
      try {
        await this.restoreFromS3(s3Key, snapshotPath);
        process.stderr.write(
          `[s3] restored snapshot from s3://${this.bucket}/${s3Key}\n`,
        );
        return;
      } catch (err) {
        process.stderr.write(
          `[s3] warning: restore failed, falling back to clone: ${String(err)}\n`,
        );
      }
    }

    // Fall back to git clone
    await this.fallbackShell.materialize({ repoFullName, commitSha, snapshotPath });

    // Upload to S3 after successful clone
    try {
      await this.uploadToS3(s3Key, snapshotPath);
      process.stderr.write(
        `[s3] uploaded snapshot → s3://${this.bucket}/${s3Key}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[s3] warning: upload failed (snapshot still local): ${String(err)}\n`,
      );
    }
  }

  private async restoreFromS3(s3Key: string, snapshotPath: string): Promise<void> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
    );

    if (!response.Body) {
      throw new Error(`Empty response body from S3 for key ${s3Key}`);
    }

    await fs.mkdir(snapshotPath, { recursive: true });

    const tarPath = `${snapshotPath}.tar.gz`;
    try {
      // Write tarball to temp file
      const uint8 = await response.Body.transformToByteArray();
      await fs.writeFile(tarPath, uint8);

      // Extract
      await tar.extract({ file: tarPath, cwd: snapshotPath, strip: 0 });
    } finally {
      await fs.rm(tarPath, { force: true });
    }
  }

  private async uploadToS3(s3Key: string, snapshotPath: string): Promise<void> {
    const tarPath = `${snapshotPath}.tar.gz`;
    try {
      // Create tarball
      await tar.create(
        { gzip: true, file: tarPath, cwd: path.dirname(snapshotPath) },
        [path.basename(snapshotPath)],
      );

      const data = await fs.readFile(tarPath);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: data,
          ContentType: "application/gzip",
        }),
      );
    } finally {
      await fs.rm(tarPath, { force: true });
    }
  }
}
