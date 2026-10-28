import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const tabs = ['Touchpad','Keyboard','Media','Apps'];
function isPrivateIPv4(host) {
  const octets=host.split('.').map(Number);
  return octets.length===4&&octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(
    octets[0]===10||octets[0]===127||(octets[0]===192&&octets[1]===168)||(octets[0]===172&&octets[1]>=16&&octets[1]<=31));
}
function normalizeReceiver(value) {
  let url; try { url=new URL(value.trim()); } catch { throw new Error('Enter the laptop receiver URL, such as https://192.168.1.25:8787.'); }
  const localHttp=url.protocol==='http:'&&(url.hostname==='localhost'||url.hostname==='127.0.0.1');
  if ((!localHttp&&url.protocol!=='https:')||(!localHttp&&!isPrivateIPv4(url.hostname))||url.port!=='8787'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new Error('Use an HTTPS URL with the laptop’s private IPv4 address and port 8787.');
  return url.origin;
}
function initialReceiver() {
  const query=new URLSearchParams(location.search).get('receiver');
  const saved=localStorage.getItem('receiver-url');
  if(query)return query;
  if(saved)return saved;
  return location.hostname==='localhost'||location.hostname==='127.0.0.1'?`http://${location.hostname}:8787`:'';
}

function App() {
  const [tab,setTab]=useState('Touchpad'); const [token,setToken]=useState(()=>sessionStorage.getItem('remote-token')||'');
  const [apiBase,setApiBase]=useState(initialReceiver);
  const [code,setCode]=useState(''); const [status,setStatus]=useState(null); const [error,setError]=useState(''); const [connecting,setConnecting]=useState(false);
  const [text,setText]=useState(''); const [sensitivity,setSensitivity]=useState(1.5); const [connected,setConnected]=useState(false);
  const [mock,setMock]=useState(new URLSearchParams(location.search).get('mock')==='true');
  const lastTap=useRef(0); const tapTimer=useRef(null); const fingers=useRef(new Map()); const multiTouch=useRef(false); const scrollCenter=useRef(null);
  async function request(path,body,auth=true,method,base=apiBase) {
    if(!base)throw new Error('Enter your laptop receiver URL first.');
    const response=await fetch(`${base}/api/${path}`,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(auth&&token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json().catch(()=>({error:'Receiver returned an unreadable response.'})); if(!response.ok) throw new Error(data.error||`Receiver error ${response.status}`); return data;
  }
  async function pair(e){e.preventDefault();setError('');try{const receiver=normalizeReceiver(apiBase);setApiBase(receiver);localStorage.setItem('receiver-url',receiver);const d=await request('pair',{code},false,undefined,receiver);sessionStorage.setItem('remote-token',d.token);setToken(d.token);setStatus(d);setConnected(true);setMock(d.mock);setCode('');}catch(err){setError(err.message);}}
  async function send(command,payload={}){if(mock&&!connected){setError('Mock preview is active. Pair with a mock receiver to record commands.');return;}try{await request('command',{command,...payload});setError('');}catch(e){setError(e.message);if(e.message.includes('Pair your phone'))disconnect();}}
  function disconnect(){if(token)request('session',null,true,'DELETE').catch(()=>{});sessionStorage.removeItem('remote-token');setToken('');setConnected(false);setStatus(null);}
  useEffect(()=>{if(!token)return;let active=true;let timer;let tries=0;const check=async()=>{setConnecting(true);try{const d=await request('status');if(!active)return;setStatus(d);setConnected(true);setMock(d.mock);setError('');setConnecting(false);}catch(e){if(!active)return;if(e.message.includes('Pair your phone')){setConnecting(false);disconnect();return;}tries++;if(tries<=6){timer=setTimeout(check,Math.min(1000*2**(tries-1),10000));}else{setConnecting(false);setError('Cannot reach the receiver. Reconnect Wi-Fi or reload to try again.');}}};check();return()=>{active=false;clearTimeout(timer);};},[]);
  useEffect(()=>{if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});},[]);
  function onPointerDown(e){e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);fingers.current.set(e.pointerId,{x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false});if(fingers.current.size>1)multiTouch.current=true;if(fingers.current.size===2){const pts=[...fingers.current.values()];scrollCenter.current=(pts[0].y+pts[1].y)/2;}}
  function onPointerMove(e){const prev=fingers.current.get(e.pointerId);if(!prev)return;const dx=e.clientX-prev.x,dy=e.clientY-prev.y;prev.moved ||= Math.hypot(e.clientX-prev.startX,e.clientY-prev.startY)>8;fingers.current.set(e.pointerId,{...prev,x:e.clientX,y:e.clientY});if(fingers.current.size>=2){const pts=[...fingers.current.values()];const center=(pts[0].y+pts[1].y)/2;const scrollDelta=scrollCenter.current===null?0:center-scrollCenter.current;scrollCenter.current=center;if(scrollDelta)send('mouse.scroll',{delta:Math.round(-scrollDelta*5)});return;}send('mouse.move',{dx:Math.round(dx*sensitivity),dy:Math.round(dy*sensitivity)});}
  function onPointerUp(e){const gesture=fingers.current.get(e.pointerId);fingers.current.delete(e.pointerId);if(fingers.current.size<2)scrollCenter.current=null;if(fingers.current.size)return;if(multiTouch.current){multiTouch.current=false;return;}if(!gesture||gesture.moved)return;const now=Date.now();if(now-lastTap.current<350){clearTimeout(tapTimer.current);send('mouse.doubleClick');lastTap.current=0;}else{lastTap.current=now;tapTimer.current=setTimeout(()=>{if(Date.now()-lastTap.current>=340)send('mouse.click');},360);}}
  return <main className="shell">
    <header className="top"><div className="brand"><span className="orb"/><div><div className="eyebrow">LIQUID GLASS</div><h1>Remote</h1></div></div><button className="connect" onClick={()=>connected?disconnect():document.querySelector('#receiver-url')?.focus()}><i className={connected?'online':''}/>{connected?'Connected':'Connect'}</button></header>
    <section className="hero glass"><div><div className="eyebrow">YOUR LAPTOP</div><h2>{status?.name||'Waiting to connect'}</h2><p>{connected?`${status.network}${status.address?` · ${status.address}`:''} · ${mock?'Mock mode':'Ready'}`:connecting?'Reconnecting to receiver…':'On the same private Wi-Fi network'}</p></div><div className="signal">⌁<span>{connected?'SECURE':connecting?'RETRYING':'OFFLINE'}</span></div></section>
    {!connected&&<form className="pair glass" onSubmit={pair}><div className="pair-head"><div><div className="eyebrow">PAIR DEVICE</div><h3>Connect to your laptop</h3></div><label className="mock-toggle"><input type="checkbox" checked={mock} onChange={e=>setMock(e.target.checked)}/> Preview</label></div><label className="input-label" htmlFor="receiver-url">Laptop receiver URL</label><div className="code-row"><input id="receiver-url" type="url" autoComplete="url" placeholder="https://192.168.1.25:8787" value={apiBase} onChange={e=>setApiBase(e.target.value)}/></div><label className="input-label" htmlFor="pair-code">One-use pairing code</label><div className="code-row"><input id="pair-code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} placeholder="10-digit code" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/><button className="primary" type="submit">Pair</button></div><p className="hint">Use the HTTPS address and temporary code shown by the Windows receiver.</p>{error&&<p className="error">{error}</p>}</form>}
    <nav className="tabs">{tabs.map(t=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t}</button>)}</nav>
    <section className="control glass">
      {tab==='Touchpad'&&<><div className="control-title"><div><div className="eyebrow">POINTER</div><h3>Touchpad</h3></div><span className="tiny">{connected?'LIVE':'PREVIEW'}</span></div><div className="pad" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={e=>{fingers.current.delete(e.pointerId);if(!fingers.current.size)multiTouch.current=false;}}><div className="pad-glow"/><div className="pad-mark"><span/><span/><span/></div><p>Touch and move to control</p></div><div className="button-row"><button className="soft-button" onClick={()=>send('mouse.click')}>Left click</button><button className="soft-button" onClick={()=>send('mouse.rightClick')}>Right click</button></div><label className="range">Cursor sensitivity <input type="range" min="0.5" max="4" step="0.1" value={sensitivity} onChange={e=>setSensitivity(+e.target.value)}/><span>{sensitivity.toFixed(1)}×</span></label></>}
      {tab==='Keyboard'&&<><div className="control-title"><div><div className="eyebrow">INPUT</div><h3>Keyboard</h3></div></div><p className="hint">Text is sent only when you press Send and is never stored by this app. Mobile keyboards may not expose all system keys.</p><form className="text-row" onSubmit={e=>{e.preventDefault();if(text){send('keyboard.text',{text});setText('');}}}><input autoComplete="off" placeholder="Type a message…" value={text} onChange={e=>setText(e.target.value)}/><button className="primary">Send</button></form><div className="key-grid">{[['Enter','ENTER'],['Tab','TAB'],['Esc','ESCAPE'],['⌫','BACKSPACE'],['↑','ARROWUP'],['←','ARROWLEFT'],['↓','ARROWDOWN'],['→','ARROWRIGHT']].map(([label,key])=><button className="key" key={key} onClick={()=>send('keyboard.key',{key})}>{label}</button>)}</div><div className="shortcut-grid">{[['Ctrl C','CTRL+C'],['Ctrl V','CTRL+V'],['Alt Tab','ALT+TAB'],['Win D','WIN+D']].map(([label,shortcut])=><button className="soft-button" key={shortcut} onClick={()=>send('keyboard.shortcut',{shortcut})}>{label}</button>)}</div></>}
      {tab==='Media'&&<><div className="control-title"><div><div className="eyebrow">PLAYBACK</div><h3>Media & volume</h3></div></div><div className="media-card"><div className="album">♫</div><div><b>System media</b><p>Controls the active Windows player</p></div></div><div className="media-row"><button onClick={()=>send('media.previous')}>◀|</button><button className="play" onClick={()=>send('media.playPause')}>Ⅱ</button><button onClick={()=>send('media.next')}>|▶</button></div><div className="volume"><span>−</span><button onClick={()=>send('volume.down')}>Volume down</button><button onClick={()=>send('volume.mute')}>Mute</button><button onClick={()=>send('volume.up')}>Volume up</button><span>＋</span></div><p className="hint">Windows media-session status and precise volume are not exposed yet.</p></>}
      {tab==='Apps'&&<><div className="control-title"><div><div className="eyebrow">QUICK LAUNCH</div><h3>Open an app</h3></div></div><p className="hint">Only these built-in Windows apps can be launched.</p><div className="app-list">{[['▤','Notepad','notepad'],['▦','Calculator','calculator'],['▱','File Explorer','explorer']].map(([icon,name,app])=><button className="app-item" key={app} onClick={()=>send('app.launch',{app})}><span>{icon}</span><b>{name}</b><span className="launch">↗</span></button>)}</div></>}
    </section>
    <footer><span className={connected?'dot on':'dot'}/>{error|| (connecting?'Reconnecting…':mock?'Mock preview · no laptop input will be sent':'Private connection · receiver required')}<button onClick={()=>setMock(!mock)}>{mock?'Mock':'Live'}</button></footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
