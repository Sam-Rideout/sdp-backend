'use strict';
const DEVICE = new Set(['DESKTOP_PC','LAPTOP','PHONE','TABLET','OTHER','NOT_SURE']);
const MICROPHONE = new Set(['BUILT_IN','USB_MICROPHONE','AUDIO_INTERFACE','WIRED_HEADSET','BLUETOOTH_HEADSET','OTHER','NOT_SURE']);
const LISTENING = new Set(['WIRED_EARBUDS','BLUETOOTH_EARBUDS','WIRED_HEADPHONES','BLUETOOTH_HEADPHONES','DEVICE_SPEAKER','EXTERNAL_SPEAKERS','OTHER','NOT_SURE']);
const own=(o,k)=>Object.hasOwn(o,k);
function setup(value,{requireBrowser=false}={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schema_version!=='PX-RECORDING-SETUP-1.0')throw new Error('Choose your recording setup before continuing.');
  const r=value.reported,b=value.browser;
  if(!r||typeof r!=='object'||Array.isArray(r)||!DEVICE.has(r.device_type)||!MICROPHONE.has(r.microphone_type)||!LISTENING.has(r.listening_setup))throw new Error('Recording setup choices are incomplete or invalid.');
  if(!b||typeof b!=='object'||Array.isArray(b))throw new Error('Microphone test information is missing.');
  const label=typeof b.microphone_label==='string'?b.microphone_label.trim():'';
  if(label.length>120||/[\u0000-\u001f\u007f]/.test(label))throw new Error('Browser microphone name is invalid.');
  if(requireBrowser&&!value.browser)throw new Error('Complete the microphone test before starting.');
  const integer=(x,min,max)=>Number.isInteger(x)&&x>=min&&x<=max?x:null;
  const boolean=x=>typeof x==='boolean'?x:null;
  return {schema_version:'PX-RECORDING-SETUP-1.0',reported:{device_type:r.device_type,microphone_type:r.microphone_type,listening_setup:r.listening_setup},browser:{microphone_label:label||null,sample_rate:integer(b.sample_rate,8000,192000),channel_count:integer(b.channel_count,1,8),echo_cancellation:boolean(b.echo_cancellation),noise_suppression:boolean(b.noise_suppression),auto_gain_control:boolean(b.auto_gain_control)}};
}
function summary(value, evidenceHash) {
  if(value===null||value===undefined)return null;
  if(!value||typeof value!=='object'||value.schema_version!=='PX-VOICE-PROFILE-RECORDING-SETUP-1.0'
    ||!['KNOWN','MIXED','PARTIAL','UNKNOWN'].includes(value.status)
    ||typeof value.compact_label!=='string'||value.compact_label.length>80
    ||typeof value.details!=='string'||value.details.length>2000
    ||!Number.isInteger(value.take_count)||value.take_count<0||value.take_count>64
    ||!Number.isInteger(value.known_take_count)||value.known_take_count<0||value.known_take_count>value.take_count
    ||!Number.isInteger(value.setup_count)||value.setup_count<0||value.setup_count>64
    ||typeof evidenceHash!=='string'||!/^[a-f0-9]{64}$/.test(evidenceHash))throw new Error('Recording setup summary is invalid.');
  if(value.status==='UNKNOWN'&&(value.setup_count!==0||value.known_take_count!==0))throw new Error('Unknown recording setup counts differ.');
  if(value.status==='KNOWN'&&(value.setup_count!==1||value.known_take_count!==value.take_count))throw new Error('Known recording setup counts differ.');
  if(value.status==='MIXED'&&value.setup_count<2)throw new Error('Mixed recording setup counts differ.');
  if(value.status==='PARTIAL'&&(value.setup_count!==1||value.known_take_count>=value.take_count))throw new Error('Partial recording setup counts differ.');
  return {schema_version:value.schema_version,status:value.status,compact_label:value.compact_label,details:value.details,
    take_count:value.take_count,known_take_count:value.known_take_count,setup_count:value.setup_count,evidence_sha256:evidenceHash};
}
function display(setupValue) {
  if(!setupValue)return {compact:'Setup unknown',details:'Recording setup unknown'};
  const s=setup(setupValue);
  const devices={DESKTOP_PC:'PC',LAPTOP:'Laptop',PHONE:'Phone',TABLET:'Tablet',OTHER:'Other device',NOT_SURE:'Device unknown'};
  const mics={BUILT_IN:'Built-in mic',USB_MICROPHONE:'USB mic',AUDIO_INTERFACE:'External mic',WIRED_HEADSET:'Wired headset',BLUETOOTH_HEADSET:'Bluetooth headset',OTHER:'Other mic',NOT_SURE:'Mic unknown'};
  const ears={WIRED_EARBUDS:'Wired earbuds',BLUETOOTH_EARBUDS:'Bluetooth earbuds',WIRED_HEADPHONES:'Wired headphones',BLUETOOTH_HEADPHONES:'Bluetooth headphones',DEVICE_SPEAKER:'Device speaker',EXTERNAL_SPEAKERS:'External speakers',OTHER:'Other listening setup',NOT_SURE:'Listening setup unknown'};
  const b=s.browser.microphone_label;
  const compact=`${devices[s.reported.device_type]} / ${mics[s.reported.microphone_type]}`;
  const details=`Recording device: ${devices[s.reported.device_type]}; selected microphone: ${mics[s.reported.microphone_type]}${b?`; browser-reported microphone: ${b}`:''}; listening: ${ears[s.reported.listening_setup]}.`;
  return {compact,details};
}
module.exports={setup,summary,display};
