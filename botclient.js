// botclient.js — headless opponent that joins a room and always plays correctly.
// Usage: node botclient.js <PORT> <CODE> <colorId>
const WebSocket = require("ws");
const [,, PORT, CODE, COLOR] = process.argv;
const ws = new WebSocket(`ws://localhost:${PORT}`);
let myId=null, myColor=Number(COLOR);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

ws.on("open",()=>{});
ws.on("message", async (buf)=>{
  const m=JSON.parse(buf.toString());
  if(m.t==="hello"){ myId=m.clientId; ws.send(JSON.stringify({t:"join",code:CODE,name:"BotBea"})); }
  if(m.t==="joined"){ ws.send(JSON.stringify({t:"pickColor",color:myColor})); }
  if(m.t==="state" || m.t==="game_start"){
    const s=m.state; if(!s||s.phase!=="PLAYING"||s.over) return;
    if(s.currentId===myId){
      // replay whole sequence then add my color, click-by-click with pacing
      const seq=s.sequence.slice();
      // start from replayPos
      for(let i=s.replayPos;i<seq.length;i++){ await sleep(350); ws.send(JSON.stringify({t:"click",color:seq[i]})); }
      const adds = s.toAdd||1;
      for(let k=0;k<adds;k++){ await sleep(350); ws.send(JSON.stringify({t:"click",color:myColor})); }
    }
  }
  if(m.t==="duel_go"){
    // play the duel correctly but a bit slowly so the human can win if they want
    const seq=m.state.duel.sequence.slice();
    for(const c of seq){ await sleep(500); ws.send(JSON.stringify({t:"duelClick",color:c})); }
  }
  if(m.t==="game_over"){ console.log("GAME_OVER winner="+m.winnerId); }
});
ws.on("error",e=>console.error("bot err",e.message));
