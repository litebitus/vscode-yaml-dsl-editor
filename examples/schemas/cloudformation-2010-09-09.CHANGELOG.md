# CloudFormation schema changelog

## 2026-10-27

Provider schemas of us-east-1 downloaded 2026-10-27, replacing those of 2026-10-17: 1,851 resource types become 1,862.

- Function table
  - `ForEach` names its identifier in `loop_variables`.

| Change | Count | Types |
|---|---|---|
| Resource types added | 15 | `AWS::BcmPricingCalculator::BillEstimate`, `AWS::Bedrock::RetrievalInstruction`, `AWS::CloudWatch::AccessProfile`, `AWS::CloudWatch::DomainAccessGrantForOrganization`, `AWS::CloudWatch::DomainForOrganization`, `AWS::CloudWatch::OmniDashboard`, `AWS::CloudWatch::Space`, `AWS::EC2::TransitGatewayAttachmentNatConfiguration`, `AWS::ECS::Gateway`, `AWS::ECS::GatewayClusterAssociations`, `AWS::IoT::OTAUpdate`, `AWS::NetworkMonitor::Probe`, `AWS::Personalize::Recommender`, `AWS::Route53Resolver::FirewallConfig`, `AWS::SecurityAgent::PrivateConnection` |
| Resource types removed | 4 | `AWS::IoTEvents::AlarmModel`, `AWS::IoTEvents::DetectorModel`, `AWS::IoTEvents::Input`, `AWS::LookoutVision::Project` |
| Resource types changed | 23 | `AWS::ARCRegionSwitch::Plan`, `AWS::AppStream::Stack`, `AWS::BedrockAgentCore::Memory`, `AWS::BedrockAgentCore::PaymentManager`, `AWS::CodeBuild::Project`, `AWS::CodeDeploy::DeploymentGroup`, `AWS::Connect::Instance`, `AWS::DRS::SourceNetwork`, `AWS::DynamoDB::GlobalTable`, `AWS::ECS::Daemon`, `AWS::ECS::Service`, `AWS::ECS::TaskDefinition`, `AWS::KMS::Key`, `AWS::Lambda::NetworkConnector`, `AWS::Lambda::ResourcePolicy`, `AWS::MediaLive::Input`, `AWS::Omics::Configuration`, `AWS::OpenSearchService::Domain`, `AWS::PCS::ComputeNodeGroup`, `AWS::QuickSight::ApprovalPolicy`, `AWS::SageMaker::Cluster`, `AWS::Transfer::HostKey`, `AWS::XRay::TransactionSearchConfig` |
