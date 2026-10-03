import type { GenerationMedia, PresignAssetRole, PresignPurpose } from '../contracts.js';

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface PutObjectResult extends GenerationMedia {}

export interface PresignGetInput {
  key: string;
  purpose: PresignPurpose;
  filename?: string;
  contentType?: string;
  ttlSeconds?: number;
  assetRole?: PresignAssetRole;
}

export interface PresignGetResult {
  url: string;
  expiresAt: string;
  contentType?: string;
  filename?: string;
}

export interface GetObjectInput {
  key: string;
  contentType?: string;
  maxBytes?: number;
}

export interface GetObjectResult {
  body: Buffer;
  contentType: string;
  size: number;
}

export interface ObjectStorageAdapter {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  presignGet(input: PresignGetInput): Promise<PresignGetResult>;
  getObject(input: GetObjectInput): Promise<GetObjectResult>;
  deleteObject?(key: string): Promise<void>;
}
