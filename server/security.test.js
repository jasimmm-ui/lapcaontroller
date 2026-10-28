import test from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual, isPrivateIPv4, inCidr, makeLimiter } from './security.js';
import { validateCommand } from './validation.js';

test('safeEqual accepts equal secrets and rejects unequal or differently sized input',()=>{assert.equal(safeEqual('1234','1234'),true);assert.equal(safeEqual('1234','1235'),false);assert.equal(safeEqual('1','11'),false);});
test('private address and subnet checks reject public clients',()=>{assert.equal(isPrivateIPv4('192.168.1.8'),true);assert.equal(isPrivateIPv4('8.8.8.8'),false);assert.equal(inCidr('192.168.1.8','192.168.1.0/24'),true);assert.equal(inCidr('192.168.2.8','192.168.1.0/24'),false);});
test('pair limiter blocks after threshold',()=>{const limit=makeLimiter({limit:2,windowMs:5000});assert.equal(limit('phone'),true);assert.equal(limit('phone'),true);assert.equal(limit('phone'),false);});
test('validates bounded touchpad payloads and rejects unknown commands',()=>{assert.equal(validateCommand({command:'mouse.move',dx:2,dy:-3}),true);assert.equal(validateCommand({command:'mouse.move',dx:5000,dy:0}),false);assert.equal(validateCommand({command:'system.exec',cmd:'calc'}),false);assert.equal(validateCommand({command:'mouse.click',extra:true}),false);});
test('validates keyboard text and fixed app allowlist',()=>{assert.equal(validateCommand({command:'keyboard.text',text:'hello 🌎'}),true);assert.equal(validateCommand({command:'keyboard.text',text:'x'.repeat(1001)}),false);assert.equal(validateCommand({command:'app.launch',app:'notepad'}),true);assert.equal(validateCommand({command:'app.launch',app:'cmd.exe'}),false);});
