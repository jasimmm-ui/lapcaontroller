import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readCredential, removeCredential, saveCredential } from './credential-vault.js';
import './style.css';

const tabs = ['Touchpad','Keyboard','Media','Apps'];
const RELAY_BASE = (import.meta.env.VITE_RELAY_URL || (import.meta.env.DEV ? 'http://127.0.0.1:8788' : '')).replace(/\/$/, '');
const DEVICE_LIST_KEY = 'liquid-glass-devices-v2';
const PHONE_ID_KEY = 'liquid-glass-phone-id-v2';

function readDevices() {
  try {
    const list = JSON.parse(localStorage.getItem(DEVICE_LIST_KEY) || '[]');
    return Array.isArray(list) ? list.filter(d => d && typeof d.id === 'string' && typeof d.name === 'string') : [];
  } catch { return []; }
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function relay(path, { method, body, token, signal } = {}) {
  if (!RELAY_BASE) throw new Error('The relay is not set up yet. Ask the relay administrator to finish deployment.');
  const response = await fetch(`${RELAY_BASE}${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...(token ? { Authorization:`Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({ error:'Relay returned an unreadable response.' }));
  if (!response.ok) { const error=new Error(data.error || `Relay error ${response.status}.`);error.status=response.status;throw error; }
  return data;
}

function App() {
  const [tab,setTab]=useState('Touchpad');
  const [devices,setDevices]=useState(readDevices);
  const [activeId,setActiveId]=useState(()=>localStorage.getItem('liquid-glass-active-v2')||'');
  const [credentials,setCredentials]=useState({});
  const [statuses,setStatuses]=useState({});
  const [heartbeat,setHeartbeat]=useState(false);
  const [code,setCode]=useState('');
  const [pairing,setPairing]=useState(false);
  const [pairMessage,setPairMessage]=useState('The laptop owner must approve the request on the laptop.');
  const [error,setError]=useState('');
  const [text,setText]=useState('');
  const [sensitivity,setSensitivity]=useState(1.5);
  const [preview,setPreview]=useState(new URLSearchParams(location.search).get('mock')==='true');
  const lastTap=useRef(0); const tapTimer=useRef(null); const fingers=useRef(new Map()); const multiTouch=useRef(false); const scrollCenter=useRef(null);
  const activeDevice=devices.find(device=>device.id===activeId)||null;
  const activeStatus=statuses[activeId]||null;
  const connected=Boolean(activeDevice&&credentials[activeId]&&activeStatus?.online);
  const mock=activeStatus?.mock ?? false;

  useEffect(()=>{
    let alive=true;
    (async()=>{
      const next={};
      for(const device of devices){
        try{const token=await readCredential(device.id);if(token)next[device.id]=token;}catch{}
      }
      if(alive)setCredentials(next);
    })();
    return()=>{alive=false;};
  },[]);

  useEffect(()=>{
    localStorage.setItem(DEVICE_LIST_KEY,JSON.stringify(devices));
    if(activeId)localStorage.setItem('liquid-glass-active-v2',activeId);else localStorage.removeItem('liquid-glass-active-v2');
  },[devices,activeId]);

  useEffect(()=>{
    if(!Object.keys(credentials).length)return;
    let alive=true;
    const check=async()=>{
      const results=await Promise.all(devices.filter(d=>credentials[d.id]).map(async d=>{
        try{return [d.id,await relay(`/v1/phones/${encodeURIComponent(d.id)}/status`,{token:credentials[d.id]})];}
        catch(e){return [d.id,{receiverId:d.id,name:d.name,online:false,mock:false,error:e.message}];}
      }));
      if(alive)setStatuses(Object.fromEntries(results));
    };
    check();const timer=setInterval(check,7000);
    return()=>{alive=false;clearInterval(timer);};
  },[credentials,devices]);

  useEffect(()=>{
    const token=credentials[activeId];
    if(!RELAY_BASE||!activeId||!token){setHeartbeat(false);return;}
    let stopped=false, socket=null, retryTimer=null, beatTimer=null, delay=1000;
    const connect=()=>{
      if(stopped)return;
      const address=new URL(RELAY_BASE);
      address.protocol=address.protocol==='https:'?'wss:':'ws:';
      address.pathname='/v1/ws/phone';
      socket=new WebSocket(address);
      socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'auth',receiverId:activeId,token})),{once:true});
      socket.addEventListener('message',event=>{
        let message;try{message=JSON.parse(String(event.data));}catch{socket.close();return;}
        if(message.type==='authenticated'){
          delay=1000;setHeartbeat(true);
          const beat=()=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'heartbeat'}));};
          beat();beatTimer=setInterval(beat,20_000);
        }
        if(message.type==='heartbeat_ack')setHeartbeat(true);
      });
      socket.addEventListener('close',()=>{
        clearInterval(beatTimer);setHeartbeat(false);
        if(!stopped){retryTimer=setTimeout(connect,delay+Math.floor(Math.random()*300));delay=Math.min(delay*2,30_000);}
      },{once:true});
      socket.addEventListener('error',()=>socket?.close());
    };
    connect();
    return()=>{stopped=true;clearTimeout(retryTimer);clearInterval(beatTimer);socket?.close(1000,'Laptop changed');setHeartbeat(false);};
  },[activeId,credentials]);

  async function pair(e){
    e.preventDefault();setError('');setPairing(true);setPairMessage('Sending a secure pairing request...');
    let phoneToken='';let receiverId='';
    try{
      if(!/^\d{3}$/.test(code))throw new Error('Enter the three-digit code shown by the laptop.');
      const phoneId=localStorage.getItem(PHONE_ID_KEY)||crypto.randomUUID();
      localStorage.setItem(PHONE_ID_KEY,phoneId);
      const phoneName=`Android phone ${phoneId.slice(-4).toUpperCase()}`;
      phoneToken=randomToken();const nonce=randomToken();
      const request=await relay('/v1/pair',{body:{code,phoneId,phoneToken,nonce,phoneName}});
      setPairMessage(`Request sent as ${phoneName}. Approve that name in the receiver window on the laptop.`);
      const until=Date.now()+125_000;
      while(Date.now()<until){
        await sleep(1100);
        const state=await relay(`/v1/pair/${encodeURIComponent(request.requestId)}`,{token:nonce});
        if(state.status==='rejected')throw new Error('The laptop owner rejected this pairing request.');
        if(state.status==='expired')throw new Error('This pairing request expired. Create a new code on the laptop and try again.');
        if(state.status==='approved'){
          receiverId=state.receiverId;
          await saveCredential(receiverId,phoneToken);
          const item={id:receiverId,name:state.receiverName||'Windows laptop'};
          setDevices(previous=>[item,...previous.filter(d=>d.id!==receiverId)]);
          setCredentials(previous=>({...previous,[receiverId]:phoneToken}));
          setActiveId(receiverId);setCode('');setPairMessage('Laptop paired. It will be saved on this phone.');return;
        }
      }
      throw new Error('No approval arrived in time. Create a fresh code on the laptop and try again.');
    }catch(e){
      if(receiverId&&phoneToken)relay(`/v1/phones/${encodeURIComponent(receiverId)}/access`,{method:'DELETE',token:phoneToken}).catch(()=>{});
      setError(e.message||'Pairing failed.');
    }finally{setPairing(false);}
  }

  async function removeDevice(device){
    const token=credentials[device.id];
    if(!window.confirm(`Remove ${device.name} and revoke this phone's access?`))return;
    try{
      if(token)await relay(`/v1/phones/${encodeURIComponent(device.id)}/access`,{method:'DELETE',token});
      await removeCredential(device.id);
      setDevices(list=>list.filter(d=>d.id!==device.id));
      setCredentials(all=>{const next={...all};delete next[device.id];return next;});
      setStatuses(all=>{const next={...all};delete next[device.id];return next;});
      if(activeId===device.id)setActiveId('');
      setError('');
    }catch(e){
      if(e.status===401){
        await removeCredential(device.id).catch(()=>{});
        setDevices(list=>list.filter(d=>d.id!==device.id));
        setCredentials(all=>{const next={...all};delete next[device.id];return next;});
        setStatuses(all=>{const next={...all};delete next[device.id];return next;});
        if(activeId===device.id)setActiveId('');
        setError('This phone access was already revoked; the saved laptop was removed from this phone.');
      } else setError(e.message);
    }
  }

  async function send(command,payload={}){
    if(preview&&!connected){setError('Preview only. Pair with a laptop to send real controls.');return;}
    if(!activeId||!credentials[activeId]){setError('Choose a saved laptop or pair one first.');return;}
    if(!activeStatus?.online){setError('This laptop is offline. Open its receiver and check its internet connection.');return;}
    try{await relay(`/v1/phones/${encodeURIComponent(activeId)}/commands`,{token:credentials[activeId],body:{command,...payload}});setError('');}
    catch(e){setError(e.message);if(e.message.includes('authentication failed'))removeDevice({id:activeId,name:activeDevice?.name||'Laptop'}).catch(()=>{});}
  }

  function onPointerDown(e){if(!connected)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);fingers.current.set(e.pointerId,{x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false});if(fingers.current.size>1)multiTouch.current=true;if(fingers.current.size===2){const pts=[...fingers.current.values()];scrollCenter.current=(pts[0].y+pts[1].y)/2;}}
  function onPointerMove(e){if(!connected)return;const prev=fingers.current.get(e.pointerId);if(!prev)return;const dx=e.clientX-prev.x,dy=e.clientY-prev.y;prev.moved ||= Math.hypot(e.clientX-prev.startX,e.clientY-prev.startY)>8;fingers.current.set(e.pointerId,{...prev,x:e.clientX,y:e.clientY});if(fingers.current.size>=2){const pts=[...fingers.current.values()];const center=(pts[0].y+pts[1].y)/2;const delta=scrollCenter.current===null?0:center-scrollCenter.current;scrollCenter.current=center;if(delta)send('mouse.scroll',{delta:Math.round(-delta*5)});return;}send('mouse.move',{dx:Math.round(dx*sensitivity),dy:Math.round(dy*sensitivity)});}
  function onPointerUp(e){const gesture=fingers.current.get(e.pointerId);fingers.current.delete(e.pointerId);if(fingers.current.size<2)scrollCenter.current=null;if(fingers.current.size)return;if(multiTouch.current){multiTouch.current=false;return;}if(!connected||!gesture||gesture.moved)return;const now=Date.now();if(now-lastTap.current<350){clearTimeout(tapTimer.current);send('mouse.doubleClick');lastTap.current=0;}else{lastTap.current=now;tapTimer.current=setTimeout(()=>{if(Date.now()-lastTap.current>=340)send('mouse.click');},360);}}

  return <main className="shell">
    <header className="top"><div className="brand"><span className="orb"/><div><div className="eyebrow">LIQUID GLASS</div><h1>Remote</h1></div></div><button className="connect" onClick={()=>{setError('');setActiveId(activeId?'':devices[0]?.id||'');}}><i className={connected?'online':''}/>{activeId?'Disconnect':'Connect'}</button></header>
    <section className="hero glass"><div><div className="eyebrow">YOUR LAPTOP</div><h2>{activeDevice?.name||'Choose a laptop'}</h2><p>{connected?`${mock?'Preview mode - no laptop input':'Secure relay connection'}`:activeDevice?activeStatus?.error||'Laptop offline - receiver will reconnect automatically':'Pair a laptop once to save it here'}</p></div><div className="signal">⌁<span>{connected?'ONLINE':activeDevice?'OFFLINE':'NOT PAIRED'}</span></div></section>
    <section className="pair glass"><div className="pair-head"><div><div className="eyebrow">SAVED DEVICES</div><h3>My laptops</h3></div><button className="soft-button add-device" onClick={()=>{setError('');document.querySelector('#pair-code')?.focus();}}>Add laptop</button></div>
      {devices.length? <div className="device-list">{devices.map(device=>{const online=Boolean(statuses[device.id]?.online&&credentials[device.id]);return <div className={`device-row ${device.id===activeId?'selected':''}`} key={device.id}><button className="device-select" onClick={()=>setActiveId(device.id)}><span className={`device-dot ${online?'online':''}`}/><span><b>{device.name}</b><small>{online?'Online':credentials[device.id]?'Offline':'Unlocking saved access...'}</small></span></button><button className="remove-device" onClick={()=>removeDevice(device)} title="Remove this paired laptop">Remove</button></div>;})}</div>:<p className="hint">No saved laptops yet. Pair once and this phone will remember it.</p>}
    </section>
    <form className="pair glass" onSubmit={pair}><div className="eyebrow">PAIR A NEW LAPTOP</div><h3>Enter its three-digit code</h3><div className="code-row"><input id="pair-code" inputMode="numeric" autoComplete="one-time-code" maxLength={3} pattern="[0-9]{3}" placeholder="000" value={code} disabled={pairing} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,3))}/><button className="primary" type="submit" disabled={pairing||code.length!==3}>{pairing?'Waiting...':'Pair'}</button></div><p className="hint">{pairing?pairMessage:'The laptop owner must approve this phone. Approval grants remote control of supported actions and is saved for next time.'}</p>{error&&<p className="error">{error}</p>}</form>
    <nav className="tabs">{tabs.map(t=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t}</button>)}</nav>
    <section className="control glass">
      {tab==='Touchpad'&&<><div className="control-title"><div><div className="eyebrow">POINTER</div><h3>Touchpad</h3></div><span className="tiny">{connected?'LIVE':preview?'PREVIEW':'OFFLINE'}</span></div><div className="pad" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={e=>{fingers.current.delete(e.pointerId);if(!fingers.current.size)multiTouch.current=false;}}><div className="pad-glow"/><div className="pad-mark"><span/><span/><span/></div><p>{connected?'Touch and move to control':'Select an online laptop to control'}</p></div><div className="button-row"><button className="soft-button" onClick={()=>send('mouse.click')}>Left click</button><button className="soft-button" onClick={()=>send('mouse.rightClick')}>Right click</button></div><label className="range">Cursor sensitivity <input type="range" min="0.5" max="4" step="0.1" value={sensitivity} onChange={e=>setSensitivity(+e.target.value)}/><span>{sensitivity.toFixed(1)}×</span></label></>}
      {tab==='Keyboard'&&<><div className="control-title"><div><div className="eyebrow">INPUT</div><h3>Keyboard</h3></div></div><p className="hint">Text is sent only when you press Send. Windows pastes it using the clipboard, replacing its current contents. Mobile keyboards may not expose all system keys.</p><form className="text-row" onSubmit={e=>{e.preventDefault();if(text){send('keyboard.text',{text});setText('');}}}><input autoComplete="off" placeholder="Type a message..." value={text} onChange={e=>setText(e.target.value)}/><button className="primary">Send</button></form><div className="key-grid">{[['Enter','ENTER'],['Tab','TAB'],['Esc','ESCAPE'],['Backspace','BACKSPACE'],['Up','ARROWUP'],['Left','ARROWLEFT'],['Down','ARROWDOWN'],['Right','ARROWRIGHT']].map(([label,key])=><button className="key" key={key} onClick={()=>send('keyboard.key',{key})}>{label}</button>)}</div><div className="shortcut-grid">{[['Ctrl C','CTRL+C'],['Ctrl V','CTRL+V'],['Alt Tab','ALT+TAB'],['Win D','WIN+D']].map(([label,shortcut])=><button className="soft-button" key={shortcut} onClick={()=>send('keyboard.shortcut',{shortcut})}>{label}</button>)}</div></>}
      {tab==='Media'&&<><div className="control-title"><div><div className="eyebrow">PLAYBACK</div><h3>Media & volume</h3></div></div><div className="media-card"><div className="album">♫</div><div><b>System media</b><p>Controls the active Windows player</p></div></div><div className="media-row"><button onClick={()=>send('media.previous')}>◀|</button><button className="play" onClick={()=>send('media.playPause')}>Ⅱ</button><button onClick={()=>send('media.next')}>|▶</button></div><div className="volume"><span>-</span><button onClick={()=>send('volume.down')}>Volume down</button><button onClick={()=>send('volume.mute')}>Mute</button><button onClick={()=>send('volume.up')}>Volume up</button><span>+</span></div><p className="hint">Windows media-session status and precise volume are not exposed yet.</p></>}
      {tab==='Apps'&&<><div className="control-title"><div><div className="eyebrow">QUICK LAUNCH</div><h3>Open an app</h3></div></div><p className="hint">Only these built-in Windows apps can be launched.</p><div className="app-list">{[['▤','Notepad','notepad'],['▦','Calculator','calculator'],['▱','File Explorer','explorer']].map(([icon,name,app])=><button className="app-item" key={app} onClick={()=>send('app.launch',{app})}><span>{icon}</span><b>{name}</b><span className="launch">↗</span></button>)}</div></>}
    </section>
    <footer><span className={connected?'dot on':'dot'}/>{error|| (connected?(mock?'Preview only - no laptop input':'Connected through secure relay'):activeDevice?'Laptop is offline - receiver reconnects automatically':'Pair a laptop to get started')}{!activeDevice&&!connected&&<button onClick={()=>setPreview(!preview)}>{preview?'Preview':'Live'}</button>}</footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
