#!/bin/sh
# Runs on emulator startup (ready.d): creates the SQS queue, DynamoDB table, and S3 bucket.
# Names come from .env (see .env.example); the queue name is the last segment of QUEUE_URL.
set -e

QUEUE_URL="${QUEUE_URL:-http://localstack:4566/000000000000/scan-jobs}"
QUEUE_NAME="${QUEUE_URL##*/}"
DLQ_NAME="${QUEUE_NAME}-dlq"
# How long a received job stays hidden from other workers. Must exceed the slowest job
# (clone timeout + scan), or SQS redelivers a job that is still running.
QUEUE_VISIBILITY_TIMEOUT="${QUEUE_VISIBILITY_TIMEOUT:-300}"
# Receives without a delete before a job moves to the dead-letter queue
MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-3}"
TABLE_NAME="${TABLE_NAME:-scans}"
BUCKET_NAME="${BUCKET_NAME:-scan-reports}"
REGION="${AWS_REGION:-us-east-1}"

aws_local() {
  aws --endpoint-url "http://localhost:4566" --region "$REGION" "$@"
}

# Each step tolerates "already exists" so restarts with persisted state still succeed.

# Dead-letter queue: jobs that were received MAX_RECEIVE_COUNT times without being deleted
# (worker crashed, hung, or was killed) land here instead of being retried forever.
DLQ_URL=$(aws_local sqs create-queue --queue-name "$DLQ_NAME" --query QueueUrl --output text)
DLQ_ARN=$(aws_local sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# Main job queue. Attributes are set separately so they also apply to an existing queue.
MAIN_URL=$(aws_local sqs create-queue --queue-name "$QUEUE_NAME" --query QueueUrl --output text)
REDRIVE="{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"$MAX_RECEIVE_COUNT\\\"}"
aws_local sqs set-queue-attributes --queue-url "$MAIN_URL" \
  --attributes "{\"VisibilityTimeout\":\"$QUEUE_VISIBILITY_TIMEOUT\",\"RedrivePolicy\":\"$REDRIVE\"}"

aws_local dynamodb describe-table --table-name "$TABLE_NAME" > /dev/null 2>&1 ||
  aws_local dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=repo,AttributeType=S AttributeName=scanId,AttributeType=S \
    --key-schema AttributeName=repo,KeyType=HASH AttributeName=scanId,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST > /dev/null

aws_local s3api head-bucket --bucket "$BUCKET_NAME" > /dev/null 2>&1 ||
  aws_local s3api create-bucket --bucket "$BUCKET_NAME" > /dev/null

echo "init.sh: created queue $QUEUE_NAME (dead-letter queue $DLQ_NAME after $MAX_RECEIVE_COUNT receives), table $TABLE_NAME, bucket $BUCKET_NAME"
