/**
 * These integration tests depend on a running MinIO installation.
 *
 * See the README for instructions.
 */
import { assert, assertEquals, assertRejects } from "./deps-tests.ts";
import { Client } from "./client.ts";
import * as errors from "./errors.ts";

const config = {
  endPoint: "localhost",
  port: 9000,
  useSSL: false,
  region: "dev-region",
  accessKey: "AKIA_DEV",
  secretKey: "secretkey",
  bucket: "dev-bucket",
  pathStyle: true,
};
const client = new Client(config);

Deno.test({
  name: "error parsing",
  fn: async () => {
    const unauthorizedClient = new Client({ ...config, secretKey: "invalid key" });
    await assertRejects(
      () => unauthorizedClient.putObject("test.txt", "This is the contents of the file."),
      (err: Error) => {
        assert(err instanceof errors.S3Error);
        assertEquals(err.statusCode, 403);
        assertEquals(err.code, "SignatureDoesNotMatch");
        assertEquals(
          err.message,
          "The request signature we calculated does not match the signature you provided. Check your key and signing method.",
        );
        assertEquals(err.bucketName, config.bucket);
        assertEquals(err.region, config.region);
      },
    );
  },
});

Deno.test({
  name: "putObject() can upload a small file",
  fn: async () => {
    const response = await client.putObject("test.txt", "This is the contents of the file.");
    assertEquals(response.etag, "f6b64dbfb5d44e98363ff586e08f7fe6"); // The etag is generated by the server, based on the contents, so this confirms it worked.
  },
});

Deno.test({
  name: "putObject() can stream a large file upload",
  fn: async () => {
    // First generate a 32MiB file in memory
    const rawData = new Uint8Array(32 * 1024 * 1024).fill(0b01010101);

    // Configure a client to upload in 5MB parts:
    const smallPartSizeClient = new Client({ ...config, partSize: 5 * 1024 * 1024 });
    const response = await smallPartSizeClient.putObject("test-32m.dat", rawData);
    assertEquals(response.etag, "4581589392ae60eafdb031f441858c7a-7"); // The etag is generated by the server, based on the contents, so this confirms it worked.
  },
});
