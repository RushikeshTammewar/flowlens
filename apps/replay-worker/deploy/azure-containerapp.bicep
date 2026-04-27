// Azure Container Apps deployment for the Flowlens replay worker.
//
// Apply via:
//   az deployment group create \
//     --resource-group flowlens-rg \
//     --template-file azure-containerapp.bicep \
//     --parameters acrName=flowlensacr imageTag=latest
//
// Prerequisites:
//   - Azure Container Registry (ACR) with the worker image already pushed
//   - Container Apps Environment provisioned in the same RG
//   - Key Vault holding OPENAI_API_KEY, REPLAY_WORKER_SHARED_SECRET, BROWSER_USE_API_KEY
//   - User-assigned Managed Identity with AcrPull on the ACR + Key Vault Secrets User on the KV

@description('Container Apps Environment resource id')
param environmentId string

@description('Azure Container Registry name (without azurecr.io)')
param acrName string

@description('Image tag, e.g. v0.0.1 or latest')
param imageTag string = 'latest'

@description('User-assigned managed identity resource id')
param managedIdentityId string

@description('Key Vault resource id (used for secret references)')
param keyVaultName string

@description('Region (defaults to RG location)')
param location string = resourceGroup().location

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'flowlens-replay-worker'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8000
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: '${acrName}.azurecr.io'
          identity: managedIdentityId
        }
      ]
      secrets: [
        {
          name: 'openai-api-key'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/openai-api-key'
          identity: managedIdentityId
        }
        {
          name: 'replay-worker-shared-secret'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/replay-worker-shared-secret'
          identity: managedIdentityId
        }
        {
          name: 'browser-use-api-key'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/browser-use-api-key'
          identity: managedIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'replay-worker'
          image: '${acrName}.azurecr.io/flowlens-replay-worker:${imageTag}'
          resources: {
            cpu: 1
            memory: '2Gi'
          }
          env: [
            { name: 'LOG_LEVEL', value: 'info' }
            { name: 'FLOWLENS_MODEL_REPLAY_AGENT', value: 'gpt-4.1-mini' }
            { name: 'FLOWLENS_MODEL_JUDGE', value: 'gpt-4.1-mini' }
            { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
            { name: 'REPLAY_WORKER_SHARED_SECRET', secretRef: 'replay-worker-shared-secret' }
            { name: 'BROWSER_USE_API_KEY', secretRef: 'browser-use-api-key' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8000 }
              initialDelaySeconds: 10
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8000 }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 10
        rules: [
          {
            name: 'http-rule'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
  tags: {
    app: 'flowlens'
    component: 'replay-worker'
  }
}

output ingressFqdn string = containerApp.properties.configuration.ingress.fqdn
