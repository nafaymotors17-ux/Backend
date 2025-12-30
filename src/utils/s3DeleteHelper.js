const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const { s3, BUCKET } = require("../aws/s3Config");

async function deletePhotosFromS3(chassisNumber) {
  const prefix = `cars/${chassisNumber}/`;

  let listedObjects = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix })
  );

  while (listedObjects.Contents && listedObjects.Contents.length > 0) {
    const deleteParams = {
      Bucket: BUCKET,
      Delete: {
        Objects: listedObjects.Contents.map((obj) => ({ Key: obj.Key })),
        Quiet: true,
      },
    };

    await s3.send(new DeleteObjectsCommand(deleteParams));

    if (!listedObjects.IsTruncated) break;

    listedObjects = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: listedObjects.NextContinuationToken,
      })
    );
  }
}

module.exports = { deletePhotosFromS3 };
