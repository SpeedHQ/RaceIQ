import type { OnlineLapIdentity } from "../server/payload";
export function lapIdentity(ownerUserId:string):OnlineLapIdentity {
  return {lapGuid:"018f0000-0000-7000-8000-000000000001",originalActivityId:"018f0000-0000-7000-8000-000000000002",sourceRevision:"sha256:fixture",sourceKind:"native_capture",ownerUserId,driverBindingId:"fixture-binding",driverBindingRevision:1};
}

export function lapEvaluationEvidence(identity: OnlineLapIdentity, selectionVersion = 1, sourceGeneration = 1) {
  return {
    selectionVersion, sourceGeneration,
    bindingEvidence: {
      capturedDriverBindingId: identity.driverBindingId,
      capturedDriverBindingRevision: identity.driverBindingRevision,
      registeredDriverBindingId: identity.driverBindingId,
      registeredDriverBindingRevision: identity.driverBindingRevision,
    },
  };
}
