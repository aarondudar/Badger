#!/bin/sh
# Runs on emulator startup (ready.d): creates the SQS queue, DynamoDB table, and S3 bucket.
# Names come from .env (see .env.example); the queue name is the last segment of QUEUE_URL.
set -e

QUEUE_URL="${QUEUE_URL:-http://localstack:4566/000000000000/scan-jobs}"
QUEUE_NAME="${QUEUE_URL##*/}"
TABLE_NAME="${TABLE_NAME:-scans}"
BUCKET_NAME="${BUCKET_NAME:-scan-reports}"
REGION="${AWS_REGION:-us-east-1}"

aws_local() {
  aws --endpoint-url "http://localhost:4566" --region "$REGION" "$@"
}

# Each step tolerates "already exists" so restarts with persisted state still succeed.
aws_local sqs create-queue --queue-name "$QUEUE_NAME" > /dev/null

aws_local dynamodb describe-table --table-name "$TABLE_NAME" > /dev/null 2>&1 ||
  aws_local dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=repo,AttributeType=S AttributeName=scanId,AttributeType=S \
    --key-schema AttributeName=repo,KeyType=HASH AttributeName=scanId,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST > /dev/null

aws_local s3api head-bucket --bucket "$BUCKET_NAME" > /dev/null 2>&1 ||
  aws_local s3api create-bucket --bucket "$BUCKET_NAME" > /dev/null

echo "init.sh: created queue $QUEUE_NAME, table $TABLE_NAME, bucket $BUCKET_NAME"
