// src/aws/lambda/deleteCarPhotos.js
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

const lambda = new LambdaClient({ region: "ap-northeast-1" });

const triggerDeletePhotos = async (chassisNumbers) => {
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: "delete_car_photos",
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ chassisNumbers })),
      })
    );
    console.log("Lambda triggered for chassis:", chassisNumbers);
  } catch (err) {
    console.error("Failed to trigger Lambda:", err);
  }
};

module.exports = triggerDeletePhotos;
