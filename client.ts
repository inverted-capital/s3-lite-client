import { TransformChunkSizes } from "./transform-chunk-sizes.ts";
import { readableStreamFromIterable } from "./deps.ts";
import * as errors from "./errors.ts";
import { isValidBucketName, isValidObjectName, isValidPort, makeDateLong, sha256digestHex } from "./helpers.ts";
import { ObjectUploader } from "./object-uploader.ts";
import { signV4 } from "./signing.ts";

export interface ClientOptions {
  /** Hostname of the endpoint. Not a URL, just the hostname with no protocol or port. */
  endPoint: string;
  accessKey: string;
  secretKey: string;
  useSSL?: boolean | undefined;
  port?: number | undefined;
  /** Default bucket name, if not specified on individual requests */
  bucket?: string;
  /** Region to use, e.g. "us-east-1" */
  region: string;
  // transport
  // sessionToken?: string | undefined;
  /**
   * For large uploads, split them into parts of this size (in bytes, allowed range 5 MB to 5 GB).
   * This is a minimum; larger part sizes may be required for large uploads or if the total size is unknown.
   */
  partSize?: number | undefined;
  /** Use path-style requests, e.g. https://endpoint/bucket/object-key instead of https://bucket/object-key (default: true) */
  pathStyle?: boolean | undefined;
}

/**
 * Metadata that can be set when uploading an object.
 */
export type ItemBucketMetadata = {
  // See https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
  ["Content-Type"]?: string;
  ["Cache-Control"]?: string;
  ["Content-Disposition"]?: string;
  ["Content-Encoding"]?: string;
  ["Content-Language"]?: string;
  ["Expires"]?: string;
  ["x-amz-acl"]?: string;
  ["x-amz-grant-full-control"]?: string;
  ["x-amz-grant-read"]?: string;
  ["x-amz-grant-read-acp"]?: string;
  ["x-amz-grant-write-acp"]?: string;
  ["x-amz-server-side-encryption"]?: string;
  ["x-amz-storage-class"]?: string;
  ["x-amz-website-redirect-location"]?: string;
  ["x-amz-server-side-encryption-customer-algorithm"]?: string;
  ["x-amz-server-side-encryption-customer-key"]?: string;
  ["x-amz-server-side-encryption-customer-key-MD5"]?: string;
  ["x-amz-server-side-encryption-aws-kms-key-id"]?: string;
  ["x-amz-server-side-encryption-context"]?: string;
  ["x-amz-server-side-encryption-bucket-key-enabled"]?: string;
  ["x-amz-request-payer"]?: string;
  ["x-amz-tagging"]?: string;
  ["x-amz-object-lock-mode"]?: string;
  ["x-amz-object-lock-retain-until-date"]?: string;
  ["x-amz-object-lock-legal-hold"]?: string;
  ["x-amz-expected-bucket-owner"]?: string;
  // Custom keys should be like "X-Amz-Meta-..."
} & { [key: string]: string };

export interface UploadedObjectInfo {
  etag: string;
  versionId: string | null;
}

/** The minimum allowed part size for multi-part uploads. https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html */
const minimumPartSize = 5 * 1024 * 1024;
/** The maximum allowed part size for multi-part uploads. https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html */
const maximumPartSize = 5 * 1024 * 1024 * 1024;
/** The maximum allowed object size for multi-part uploads. https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html */
const maxObjectSize = 5 * 1024 * 1024 * 1024 * 1024;

export class Client {
  readonly host: string;
  readonly port: number;
  readonly protocol: "https:" | "http:";
  readonly accessKey: string;
  readonly #secretKey: string;
  readonly defaultBucket: string | undefined;
  readonly region: string;
  readonly userAgent = "deno-s3-lite-client";
  /** Use path-style requests, e.g. https://endpoint/bucket/object-key instead of https://bucket/object-key */
  readonly pathStyle: boolean;

  constructor(params: ClientOptions) {
    // Default values if not specified.
    if (params.useSSL === undefined) {
      params.useSSL = true;
    }
    // Validate input params.
    if (
      typeof params.endPoint !== "string" || params.endPoint.length === 0 ||
      params.endPoint.indexOf("/") !== -1
    ) {
      throw new errors.InvalidEndpointError(
        `Invalid endPoint : ${params.endPoint}`,
      );
    }
    if (params.port !== undefined && !isValidPort(params.port)) {
      throw new errors.InvalidArgumentError(`Invalid port : ${params.port}`);
    }

    this.port = params.port ?? (params.useSSL ? 443 : 80);
    this.host = params.endPoint.toLowerCase() +
      (params.port ? `:${params.port}` : "");
    this.protocol = params.useSSL ? "https:" : "http:";
    this.accessKey = params.accessKey;
    this.#secretKey = params.secretKey;
    this.pathStyle = params.pathStyle ?? true; // Default path style is true
    this.defaultBucket = params.bucket;
    this.region = params.region;
  }

  protected getBucketName(options: undefined | { bucketName?: string }) {
    const bucketName = options?.bucketName ?? this.defaultBucket;
    if (bucketName === undefined || !isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(
        `Invalid bucket name: ${bucketName}`,
      );
    }
    return bucketName;
  }

  /**
   * Make a single request to S3
   */
  public async makeRequest({ method, payload, ...options }: {
    method: "POST" | "GET" | "PUT" | "DELETE" | string;
    headers?: Headers;
    query?: string | Record<string, string>;
    objectName: string;
    bucketName?: string;
    /** The status code we expect the server to return */
    statusCode?: number;
    /** The request body */
    payload?: Uint8Array | string;
    /**
     * returnBody: We have to read the request body to avoid leaking resources.
     * So by default this method will read and ignore the body. If you actually
     * need it, set returnBody: true and this function won't touch it so that
     * the caller can read it.
     */
    returnBody?: boolean;
  }): Promise<Response> {
    const date = new Date();
    const bucketName = this.getBucketName(options);
    const headers = options.headers ?? new Headers();
    const host = this.pathStyle ? this.host : `${bucketName}.${this.host}`;
    const queryAsString = typeof options.query === "object"
      ? new URLSearchParams(options.query).toString()
      : (options.query);
    const path = (this.pathStyle ? `/${bucketName}/${options.objectName}` : `/${options.objectName}`) +
      (queryAsString ? `?${queryAsString}` : "");
    const statusCode = options.statusCode ?? 200;

    if (
      method === "POST" || method === "PUT" || method === "DELETE"
    ) {
      if (payload === undefined) {
        payload = new Uint8Array();
      } else if (typeof payload === "string") {
        payload = new TextEncoder().encode(payload);
      }
      headers.set("Content-Length", String(payload.length));
    } else if (payload) {
      throw new Error(`Unexpected payload on ${method} request.`);
    }
    const sha256sum = await sha256digestHex(payload ?? new Uint8Array());
    headers.set("host", host);
    headers.set("x-amz-date", makeDateLong(date));
    headers.set("x-amz-content-sha256", sha256sum);
    headers.set(
      "authorization",
      await signV4({
        headers,
        method,
        path,
        accessKey: this.accessKey,
        secretKey: this.#secretKey,
        region: this.region,
        date,
      }),
    );

    const fullUrl = `${this.protocol}//${host}${path}`;

    const response = await fetch(fullUrl, {
      method,
      headers,
      body: payload,
    });

    if (response.status !== statusCode) {
      if (response.status >= 400) {
        const error = await errors.parseServerError(response);
        throw error;
      } else {
        throw new errors.S3Error(
          response.status,
          "UnexpectedStatusCode",
          `Unexpected response code from the server (expected ${statusCode}, got ${response.status} ${response.statusText}).`,
        );
      }
    }
    if (!options.returnBody) {
      // Just read the body and ignore its contents, to avoid leaking resources.
      await response.body?.getReader().read();
    }
    return response;
  }

  async putObject(
    objectName: string,
    streamOrData: ReadableStream<Uint8Array> | Uint8Array | string,
    options?: {
      metaData?: ItemBucketMetadata;
      size?: number;
      bucketName?: string;
      /**
       * For large uploads, split them into parts of this size.
       * Default: 64MB if object size is known, 500MB if total object size is unknown.
       * This is a minimum; larger part sizes may be required for large uploads or if the total size is unknown.
       */
      partSize?: number;
    },
  ): Promise<UploadedObjectInfo> {
    const bucketName = this.getBucketName(options);
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(
        `Invalid object name: ${objectName}`,
      );
    }

    // Prepare a readable stream for the upload:
    let size: number | undefined;
    let stream: ReadableStream<Uint8Array>;
    if (typeof streamOrData === "string") {
      // Convert to binary using UTF-8
      const binaryData = new TextEncoder().encode(streamOrData);
      stream = readableStreamFromIterable([binaryData]);
      size = binaryData.length;
    } else if (streamOrData instanceof Uint8Array) {
      stream = readableStreamFromIterable([streamOrData]);
      size = streamOrData.byteLength;
    } else if (streamOrData instanceof ReadableStream) {
      stream = streamOrData;
    } else {
      throw new errors.InvalidArgumentError(
        `Invalid stream/data type provided.`,
      );
    }

    // Validate the size parameter
    if (options?.size !== undefined) {
      if (size !== undefined && options?.size !== size) {
        throw new errors.InvalidArgumentError(
          `size was specified (${options.size}) but doesn't match auto-detected size (${size}).`,
        );
      }
      if (typeof size !== "number" || size < 0 || isNaN(size)) {
        throw new errors.InvalidArgumentError(
          `invalid size specified: ${options.size}`,
        );
      } else {
        size = options.size;
      }
    }

    // Determine the part size, if we may need to do a multi-part upload.
    const partSize = options?.partSize ?? this.calculatePartSize(size);
    if (partSize < minimumPartSize) {
      throw new errors.InvalidArgumentError(`Part size should be greater than 5MB`);
    } else if (partSize > maximumPartSize) {
      throw new errors.InvalidArgumentError(`Part size should be less than 6MB`);
    }

    // s3 requires that all non-end chunks be at least `this.partSize`,
    // so we chunk the stream until we hit either that size or the end before
    // we flush it to s3.
    const chunker = new TransformChunkSizes(partSize);

    // This is a Writable stream that can be written to in order to upload
    // to the specified bucket and object automatically.
    const uploader = new ObjectUploader({
      client: this,
      bucketName,
      objectName,
      partSize,
      metaData: options?.metaData ?? {},
    });
    // stream => chunker => uploader
    await stream.pipeThrough(chunker).pipeTo(uploader);
    return uploader.getResult();
  }

  /**
   * Calculate part size given the object size. Part size will be at least this.partSize.
   *
   * Per https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html we have to
   * stick to the following rules:
   * - part size between 5MB (this.maximumPartSize) and 5GB (this.maxObjectSize)
   *   (the final part can be smaller than 5MB however)
   * - maximum of 10,000 parts per upload
   * - maximum object size of 5TB
   */
  protected calculatePartSize(size: number | undefined) {
    if (size === undefined) {
      // If we don't know the total size (e.g. we're streaming data), assume it's
      // the largest allowed object size, so we can guarantee the upload works
      // regardless of the total size.
      size = maxObjectSize;
    }
    if (size > maxObjectSize) {
      throw new TypeError(`size should not be more than ${maxObjectSize}`);
    }
    let partSize = 64 * 1024 * 1024; // Start with 64MB
    while (true) {
      // If partSize is big enough to accomodate the object size, then use it.
      if ((partSize * 10_000) > size) {
        return partSize;
      }
      // Try part sizes as 64MB, 80MB, 96MB etc.
      partSize += 16 * 1024 * 1024;
    }
  }
}
