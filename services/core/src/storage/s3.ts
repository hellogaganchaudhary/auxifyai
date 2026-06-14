/**
 * S3 / MinIO-backed {@link ObjectStore}.
 *
 * Talks to object storage through a narrow {@link S3ClientPort} rather than the
 * concrete AWS SDK client, so the same backend works against S3 (AWS), Blob
 * Storage (Azure, via an S3-compatible shim), or MinIO (local) — and stays
 * unit-testable without network access. This is the single boundary where the
 * platform depends on a particular object-store vendor (Req 44.5).
 */

import type { ObjectStore, PutObjectOptions } from './interfaces.js';
import { ObjectNotFoundError } from './interfaces.js';

/** Command input for an object write. */
export interface S3PutObjectInput {
  Bucket: string;
  Key: string;
  Body: Uint8Array;
  ContentType?: string;
  Metadata?: Record<string, string>;
}

/** Command input addressing a single object. */
export interface S3ObjectRef {
  Bucket: string;
  Key: string;
}

/** Minimal result of a `getObject` call. */
export interface S3GetObjectResult {
  /** Object bytes. Implementations may also surface a stream; the adapter only
   *  requires a way to obtain the full byte array via `transformToByteArray`. */
  Body?: {
    transformToByteArray(): Promise<Uint8Array>;
  };
}

/**
 * Narrow port mirroring the subset of the AWS S3 client the object store needs.
 * Method names follow the AWS SDK v3 command pattern so an adapter over
 * `@aws-sdk/client-s3` is a thin wrapper. A "not found" read MUST reject with
 * an error whose `name` is `NoSuchKey` (or HTTP 404), matching S3/MinIO.
 */
export interface S3ClientPort {
  putObject(input: S3PutObjectInput): Promise<void>;
  getObject(input: S3ObjectRef): Promise<S3GetObjectResult>;
  deleteObject(input: S3ObjectRef): Promise<void>;
  headObject(input: S3ObjectRef): Promise<void>;
}

/** Configuration for {@link S3ObjectStore}. */
export interface S3ObjectStoreOptions {
  /** Target bucket (e.g. `auxify-local`). */
  bucket: string;
  /** Optional key prefix applied to every object (e.g. `tenant-a/`). */
  keyPrefix?: string;
}

/** True if an error from the S3 port represents a missing object. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.Code === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  );
}

/** Production {@link ObjectStore} backed by S3-compatible storage. */
export class S3ObjectStore implements ObjectStore {
  private readonly bucket: string;
  private readonly keyPrefix: string;

  constructor(
    private readonly client: S3ClientPort,
    options: S3ObjectStoreOptions,
  ) {
    this.bucket = options.bucket;
    this.keyPrefix = options.keyPrefix ?? '';
  }

  private fullKey(key: string): string {
    return this.keyPrefix ? `${this.keyPrefix}${key}` : key;
  }

  async put(
    key: string,
    data: Uint8Array,
    options?: PutObjectOptions,
  ): Promise<void> {
    await this.client.putObject({
      Bucket: this.bucket,
      Key: this.fullKey(key),
      Body: data,
      ContentType: options?.contentType,
      Metadata: options?.metadata,
    });
  }

  async get(key: string): Promise<Uint8Array> {
    let result: S3GetObjectResult;
    try {
      result = await this.client.getObject({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      });
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
    if (!result.Body) throw new ObjectNotFoundError(key);
    return result.Body.transformToByteArray();
  }

  async delete(key: string): Promise<void> {
    await this.client.deleteObject({
      Bucket: this.bucket,
      Key: this.fullKey(key),
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.headObject({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}
