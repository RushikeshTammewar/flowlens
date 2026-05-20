# Flowlens replay worker — deployment

The worker is a stateless Python service that scales horizontally. Both AWS
App Runner and Azure Container Apps offer scale-to-zero pay-per-vCPU-second
billing — pick whichever credit pool you're drawing from. The Dockerfile is
identical for both targets.

## Trade-off summary

| Concern                  | AWS App Runner                            | Azure Container Apps                              |
| ------------------------ | ----------------------------------------- | ------------------------------------------------- |
| Cold-start latency       | ~3–5 s (provisioned concurrency available) | ~2–4 s (KEDA-based scaling)                       |
| Scale-to-zero            | Yes (since Aug 2024)                       | Yes (default)                                     |
| Per-vCPU-second pricing  | $0.000064 (active) / $0.000038 (provisioned) | $0.000024 active / $0.000003 idle                 |
| Per-GB-second pricing    | $0.000007                                  | $0.000003                                          |
| Secret store             | AWS Secrets Manager                        | Azure Key Vault                                   |
| Image registry           | ECR                                        | ACR                                                |
| Custom domain            | Yes (free TLS via ACM)                     | Yes (free TLS via Container Apps Env)             |
| Per-org rate-limiting    | App Runner native or AWS WAF in front     | Container Apps native or Azure Front Door         |

Both meet the Phase 3 requirement of <10 s cold-start booting `browser-use`.
The decision boils down to which credit pool ($10K AWS or Azure) is being
drawn from — the architecture and contract are identical.

## AWS App Runner path

1. Build + push image:
   ```bash
   AWS_REGION=us-east-1
   AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   ECR_URL=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/flowlens-replay-worker
   aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_URL
   docker build -t $ECR_URL:latest -f Dockerfile .
   docker push $ECR_URL:latest
   ```

2. Provision secrets in Secrets Manager:
   ```bash
   aws secretsmanager create-secret --name flowlens/openai_api_key --secret-string "$OPENAI_API_KEY"
   aws secretsmanager create-secret --name flowlens/replay_worker_shared_secret --secret-string "$(openssl rand -hex 32)"
   aws secretsmanager create-secret --name flowlens/browser_use_api_key --secret-string "$BROWSER_USE_API_KEY"
   ```

3. Apply the App Runner service config:
   ```bash
   aws apprunner create-service --cli-input-yaml file://aws-apprunner.yaml
   ```

## Azure Container Apps path

1. Build + push image:
   ```bash
   ACR=flowlensacr
   az acr login --name $ACR
   docker build -t $ACR.azurecr.io/flowlens-replay-worker:latest -f Dockerfile .
   docker push $ACR.azurecr.io/flowlens-replay-worker:latest
   ```

2. Provision secrets in Key Vault:
   ```bash
   KV=flowlens-kv
   az keyvault secret set --vault-name $KV --name openai-api-key --value "$OPENAI_API_KEY"
   az keyvault secret set --vault-name $KV --name replay-worker-shared-secret --value "$(openssl rand -hex 32)"
   az keyvault secret set --vault-name $KV --name browser-use-api-key --value "$BROWSER_USE_API_KEY"
   ```

3. Apply the Bicep template:
   ```bash
   az deployment group create \
     --resource-group flowlens-rg \
     --template-file azure-containerapp.bicep \
     --parameters \
       environmentId=/subscriptions/.../containerappenv-id \
       acrName=flowlensacr \
       imageTag=latest \
       managedIdentityId=/subscriptions/.../managed-identity-id \
       keyVaultName=flowlens-kv
   ```

## CI

`.github/workflows/replay-worker-deploy.yml` (manual trigger) builds the image
and dispatches to whichever cloud you select via the `cloud` input. It does NOT
run on every push — replay worker deploys are intentionally manual until we
have a smoke-test gate.

## Health & observability

- `/healthz` — liveness probe used by both clouds.
- Structured JSON logs to stdout — picked up by CloudWatch on AWS, Log Analytics on Azure.
- Per-LLM-call cost tracking via `app.telemetry.log_llm_call` — feed into your
  spend dashboard of choice.
