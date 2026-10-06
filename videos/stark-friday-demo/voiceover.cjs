const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const {loadConfig}=require('../../src/config');
const cfg=loadConfig(path.join(os.homedir(),'Library/Application Support/Project Stark'));
const lines=[
{id:'hook',at:0.8,text:'What if your best expert could be beside everyone on your team?'},
{id:'teach',at:9,text:'Meet Friday. Show her how you work. Explain what matters, and why.'},
{id:'expert',at:16,text:'New equipment over five thousand euros goes to capital expenditure. Always add the asset number before approval.'},
{id:'skill',at:24,text:'Friday turns that experience into a skill your team can learn.'},
{id:'learn',at:31,text:'Now, someone new can work with Friday. She guides them through the real application, using the knowledge your expert shared.'},
{id:'spot',at:45,text:'As they grow more confident, just say: Friday, spot me. She gives them room to work, and speaks up when something needs a second look.'},
{id:'close',at:63,text:'Your expertise. Shared across your team. Stark. Meet Friday.'}
];
(async()=>{
const vr=await fetch('https://api.elevenlabs.io/v1/voices/'+encodeURIComponent(cfg.elevenLabs.voiceId),{headers:{'xi-api-key':cfg.elevenLabs.apiKey}});const v=await vr.json();if(!vr.ok)throw new Error('Configured voice unavailable: '+vr.status);console.log('VOICE',v.name);
const meta=[];fs.mkdirSync(path.join(__dirname,'assets/audio'),{recursive:true});
for(const l of lines){const file=path.join(__dirname,'assets/audio',l.id+'.mp3');if(!fs.existsSync(file)){
 const res=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+encodeURIComponent(cfg.elevenLabs.voiceId)+'?output_format=mp3_44100_128',{method:'POST',headers:{'xi-api-key':cfg.elevenLabs.apiKey,'Content-Type':'application/json'},body:JSON.stringify({text:l.text,model_id:'eleven_multilingual_v2',voice_settings:{stability:.58,similarity_boost:.82,style:.12,use_speaker_boost:true,speed:.98}})});if(!res.ok)throw new Error('ElevenLabs '+res.status+': '+(await res.text()).slice(0,180));fs.writeFileSync(file,Buffer.from(await res.arrayBuffer()));}
const duration=Number(execFileSync('/opt/homebrew/bin/ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file],{encoding:'utf8'}).trim());meta.push({...l,path:'assets/audio/'+l.id+'.mp3',duration});console.log(l.id,duration);
fs.writeFileSync(path.join(__dirname,'audio_meta.json'),JSON.stringify({provider:'elevenlabs',voice:v.name,voices:meta},null,2));
}
fs.writeFileSync(path.join(__dirname,'SCRIPT.md'),'# Stark narration\n\n'+lines.map(l=>`**${l.at}s — ${l.id}**\n\n${l.text}`).join('\n\n'));
})().catch(e=>{console.error(e.message);process.exitCode=1});
