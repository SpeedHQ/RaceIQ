import { Cause, Data, Effect, Fiber, Layer, Queue, Schema } from "effect";
import * as PersistedQueue from "effect/persistence/PersistedQueue";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { join } from "node:path";
import { resolveOnlineDataDir } from "./runtime";
import { getProfileDelivery,listProfileDeliveries,type ProfileDelivery } from "./profile-storage";
import { subscribeOnlineSync } from "./sync-events";
import type { OnlineProfileSyncContext,RaceIqOnlineService } from "./service";
import { hashActivityContribution,type ActivityContributionHashInput } from "@speedhq/live-client";
export type ActivityContributionHashProvider = (input:ActivityContributionHashInput)=>Promise<string>;
class ProfileRuntimeError extends Data.TaggedError("ProfileRuntimeError")<{readonly phase:string}>{}

export interface ProfileCoordinatorPort {
  service:RaceIqOnlineService;
  prepare(context:OnlineProfileSyncContext,hash:ActivityContributionHashProvider):Promise<boolean>;
  deliver(delivery:ProfileDelivery,context:OnlineProfileSyncContext,mayStart:()=>boolean,hash:ActivityContributionHashProvider):Promise<"ack"|"retry">;
}
export interface OnlineProfileCoordinator {readonly ready:Promise<void>;readonly completion:Promise<void>;stop():Promise<void>}
export function startOnlineProfileCoordinator(port:ProfileCoordinatorPort):OnlineProfileCoordinator {
  let stopping=false;
  const started=Promise.withResolvers<void>();
  const wakes=Effect.runSync(Queue.sliding<void>(1));
  const unsubscribe=subscribeOnlineSync(()=>{void Effect.runPromise(Queue.offer(wakes,undefined));});
  const store=PersistedQueue.layerStoreSql({pollInterval:"1 second"});
  const program=Effect.gen(function*(){
    const queue=yield* PersistedQueue.make({name:"raceiq-online-profile-v2",schema:Schema.Struct({id:Schema.String,accountId:Schema.String}),maxAttempts:2_147_483_647});
    yield* Effect.sync(()=>started.resolve());
    const delivery=Effect.forever()(queue.take((reference)=>Effect.gen(function*(){
      const row=yield* Effect.tryPromise({try:()=>getProfileDelivery(reference.id,reference.accountId),catch:()=>new ProfileRuntimeError({phase:"profile_storage"})});
      if(!row||!["queued","ambiguous","blocked"].includes(row.state)) return;
      if(row.retryNotBeforeAt>Date.now())return yield* Effect.fail(new ProfileRuntimeError({phase:"profile_retry"}));
      const context=yield* Effect.tryPromise({try:()=>port.service.getProfileSyncContext(),catch:()=>new ProfileRuntimeError({phase:"profile_context"})});
      if(stopping||!context||context.accountId!==row.accountId) return yield* Effect.fail(new ProfileRuntimeError({phase:"profile_paused"}));
      if(stopping||!port.service.isProfileSyncContextCurrent(context)) return yield* Effect.fail(new ProfileRuntimeError({phase:"profile_paused"}));
      const outcome=yield* Effect.uninterruptible(Effect.tryPromise({try:()=>port.deliver(row,context,()=>!stopping&&port.service.isProfileSyncContextCurrent(context),hashActivityContribution),catch:()=>new ProfileRuntimeError({phase:"profile_delivery"})}));
      yield* Queue.offer(wakes,undefined);
      if(outcome==="retry") return yield* Effect.fail(new ProfileRuntimeError({phase:"profile_retry"}));
    })).pipe(Effect.catchCause(cause=>Cause.hasInterruptsOnly(cause)?Effect.failCause(cause):Effect.void)));
    const deliveryFiber=yield* Effect.forkScoped()(delivery);
    while(!stopping) {
      const reconciled=yield* Effect.tryPromise({try:async()=>{
        const context=await port.service.getProfileSyncContext();
        if(!context||stopping)return {rows:[],more:false};
        // Immutable delivery bodies are protected per activity, not by stopping unrelated source preparation.
        const more=await port.prepare(context,hashActivityContribution);
        if(stopping||!port.service.isProfileSyncContextCurrent(context))return {rows:[],more:false};
        return {rows:await listProfileDeliveries(context.accountId),more};
      },catch:()=>new ProfileRuntimeError({phase:"profile_reconciliation"})}).pipe(
        Effect.catchCause(cause=>Cause.hasInterruptsOnly(cause)?Effect.failCause(cause):Effect.succeed({rows:[],more:false})));
      for(const row of reconciled.rows){
        if(stopping)break;
        yield* queue.offer({id:row.id,accountId:row.accountId},{id:row.id,...(row.retryNotBeforeAt>Date.now()?{delay:`${row.retryNotBeforeAt-Date.now()} millis`}:{})});
      }
      if(reconciled.more)continue;
      if(!stopping) yield* Effect.race(Queue.take(wakes),Effect.sleep("60 seconds"));
    }
    yield* Fiber.interrupt(deliveryFiber);
  }).pipe(Effect.provide(Layer.provide(
    Layer.merge(Layer.provideMerge(PersistedQueue.layer,store),Layer.provide(PersistedQueue.layerCleanup(),store)),
    SqliteClient.layer({filename:join(resolveOnlineDataDir(),"raceiq-online-profile-queue.db")}),
  )));
  const fiber=Effect.runFork(Effect.scoped(program));
  const completion=Effect.runPromise(Fiber.await(fiber)).then(()=>{
    if(!stopping){const failure=new Error("Online profile runtime unavailable");started.reject(failure);throw failure;}
  });
  return {ready:started.promise,completion,async stop(){stopping=true;unsubscribe();await Effect.runPromise(Queue.offer(wakes,undefined));await Effect.runPromise(Fiber.await(fiber));}};
}
