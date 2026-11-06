import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";

function fixtureModel() {
  return {model:"independent/authored",available:true,
    async json(){return {ambiguous:true,focus:"duck",readings:[
      {label:"bird",paraphrase:"I saw her pet duck.",translation:"Vi su pato.",consequence:"A bird."},
      {label:"motion",paraphrase:"I saw her lower her head.",translation:"La vi agacharse.",consequence:"A motion."}
    ]};},
    async chat(messages){
      const text=messages[1].content.split("\n").slice(1).join("\n").trim();
      return text==="Vi su pato."?"I saw his duck.":text==="La vi agacharse."?"I saw her crouch.":"La vi agacharse.";
    }
  };
}
async function receive(sender, fn) {
  const recipient=sender==="a"?"b":"a";
  const server=createApp({llm:fixtureModel()}).listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  const post=async(path,body)=>{const response=await fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({room:"independent",...body})});return {status:response.status,body:await response.json()};};
  const state=async()=>await(await fetch(base+"/api/state?room=independent")).json();
  try {
    const analysis=await post("/api/analyze",{seat:sender,text:"I saw her duck."});
    assert.equal(analysis.status,200);assert.equal(analysis.body.flagged,true);
    const sent=await post("/api/send",{seat:sender,analysisId:analysis.body.analysisId,pick:"B"});
    assert.equal(sent.status,200);
    const id=sent.body.message.id;
    const answer=reading=>post("/api/understood",{id,seat:recipient,reading});
    const clarify=(seat=sender)=>post("/api/clarify",{id,seat});
    await fn({post,state,id,sender,recipient,answer,clarify,sent:sent.body.message});
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
const preserved = m => ({text:m.text,intended:m.intended,delivered:m.delivered,options:m.options});
for (const sender of ["a","b"]) {
  test("clarification requires a new recipient response and preserves prior evidence: "+sender,async()=>{
    await receive(sender,async({state,answer,clarify,sent})=>{
      assert.equal((await answer("A")).body.message.status,"mismatch");
      const clarified=await clarify();
      assert.equal(clarified.status,200);
      const m=clarified.body.message;
      assert.equal(m.status,"clarification_pending");
      assert.equal(m.receiverRead,"A");
      assert.deepEqual(preserved(m),preserved(sent));
      assert.equal(m.clarifications.length,1);
      assert.equal(m.clarifications[0].receiverRead,"A");
      assert.deepEqual(m.clarifications[0], {receiverRead:"A", intended:"B", text:sent.delivered});
      const history=structuredClone(m.clarifications);
      const before=await state();
      assert.equal((await clarify()).status,409);
      assert.deepEqual(await state(),before);
      const agree=await answer("B");
      assert.equal(agree.status,200);
      assert.equal(agree.body.message.status,"aligned");
      assert.equal(agree.body.message.receiverRead,"B");
      assert.deepEqual(agree.body.message.clarifications,history);
      assert.deepEqual(preserved(agree.body.message),preserved(sent));
      assert.equal((await state()).messages[0].status,"aligned");
    });
  });
  test("recipient can disagree again, receive another clarification, then agree: "+sender,async()=>{
    await receive(sender,async({answer,clarify})=>{
      await answer("A");const first=await clarify();
      assert.equal(first.body.message.status,"clarification_pending");
      const old=structuredClone(first.body.message.clarifications);
      const again=await answer("A");
      assert.equal(again.body.message.status,"mismatch");
      assert.deepEqual(again.body.message.clarifications,old);
      const second=await clarify();
      assert.equal(second.body.message.status,"clarification_pending");
      assert.equal(second.body.message.receiverRead,"A");
      assert.equal(second.body.message.clarifications.length,2);
      assert.deepEqual(second.body.message.clarifications[0],old[0]);
      const history=structuredClone(second.body.message.clarifications);
      const agreed=await answer("B");
      assert.equal(agreed.body.message.status,"aligned");
      assert.deepEqual(agreed.body.message.clarifications,history);
    });
  });
  test("participant selectors refuse the wrong role without altering message evidence: "+sender,async()=>{
    await receive(sender,async({post,state,id,recipient,sender,answer,clarify})=>{
      await answer("A");
      for(const seat of [recipient,undefined,"invalid"]){
        const before=await state();
        assert.equal((await post("/api/clarify",{id,seat})).status,seat===recipient?403:400);
        assert.deepEqual(await state(),before);
      }
      assert.equal((await clarify()).body.message.status,"clarification_pending");
      for(const seat of [sender,undefined,"invalid"]){
        const before=await state();
        assert.equal((await post("/api/understood",{id,seat,reading:"B"})).status,seat===sender?403:400);
        assert.deepEqual(await state(),before);
      }
    });
  });
  test("ordinary recipient agreement still works without clarification: "+sender,async()=>{
    await receive(sender,async({answer})=>{
      const result=await answer("B");
      assert.equal(result.status,200);assert.equal(result.body.message.status,"aligned");
    });
  });
}
