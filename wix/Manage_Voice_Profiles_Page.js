// New Wix page: Manage Voice Profiles. See README for the required element IDs.
import { authentication } from 'wix-members-frontend';
import { getVoiceProfileStatus, requestVoiceProfileDeletion } from 'backend/songSelection.web';

$w.onReady(function () {
  const picker=$w('#profileDropdown'), details=$w('#profileDetails'), status=$w('#profileStatus');
  const remove=$w('#deleteProfileButton'), confirm=$w('#confirmDeleteButton'), cancel=$w('#cancelDeleteButton');
  let profiles=[],selected='',pending=null,busy=false,revision=0;
  confirm.label='Confirm Profile Deletion';cancel.label='Keep Profile';remove.label='Delete This Profile';
  function chosen(){return profiles.find(p=>p.voiceProfileId===selected&&p.status==='READY');}
  function render(){
    picker.options=profiles.filter(p=>p.status==='READY').map(p=>({label:p.label,value:p.voiceProfileId}));
    if(selected)picker.value=selected;else picker.selectedIndex=undefined;
    picker.disable();remove.disable();confirm.disable();cancel.disable();
    if(!busy&&authentication.loggedIn()){picker.enable();if(chosen())remove.enable();}
    if(pending){confirm.show();cancel.show();if(!busy){confirm.enable();cancel.enable();}picker.disable();remove.disable();}
    else {confirm.hide();cancel.hide();}
    const p=chosen();details.text=p?`Selected profile: ${p.label}\nFull title: ${p.technicalTitle || p.label}\nDeleting it leaves your customer account and other voice profiles in place.`:
      'Your customer account stays open even if you delete every voice profile. You can return later and create a new profile.';
  }
  async function refresh(message=''){
    const version=++revision;pending=null;busy=true;render();
    if(!authentication.loggedIn()){profiles=[];selected='';busy=false;status.text='Sign in to manage your voice profiles.';render();return;}
    try{const result=await getVoiceProfileStatus();if(version!==revision||!authentication.loggedIn())return;
      profiles=Array.isArray(result.profiles)?result.profiles:[];
      if(!chosen())selected=profiles.find(p=>p.status==='READY')?.voiceProfileId||'';
      status.text=message||(selected?'Choose the profile you want to remove.':'No available voice profiles. Your customer account remains open.');
    }catch(e){if(version!==revision)return;profiles=[];selected='';status.text='Could not load your profiles. Please try again.';}
    finally{if(version===revision){busy=false;render();}}
  }
  picker.onChange(()=>{if(busy||pending)return;selected=picker.value;render();});
  remove.onClick(()=>{const p=chosen();if(busy||!p)return;pending={id:p.voiceProfileId,label:p.label,revision};
    status.text=`Request permanent deletion of “${p.label}”? Your other profiles and customer account will remain. File removal is completed after any active work is resolved.`;render();});
  cancel.onClick(()=>{if(busy)return;pending=null;status.text='Profile kept. No deletion was requested.';render();});
  confirm.onClick(async()=>{if(busy||!pending||!authentication.loggedIn())return;
    const action={...pending};busy=true;render();
    try{const result=await requestVoiceProfileDeletion(action.id,true);
      if(action.revision!==revision||!authentication.loggedIn())return;
      if(result.voiceProfileId!==action.id||result.ok!==true)throw new Error('Profile response mismatch.');
      await refresh(`Deletion requested for “${action.label}”. It is unavailable for new song selections. Your account and other profiles remain available.`);
    }catch(e){if(action.revision!==revision)return;busy=false;pending=null;status.text='Could not confirm the deletion request. Refresh your profile list before trying again.';render();}
  });
  authentication.onLogin(()=>{++revision;pending=null;refresh();});
  authentication.onLogout(()=>{++revision;profiles=[];selected='';pending=null;busy=false;status.text='Sign in to manage your voice profiles.';render();});
  render();refresh();
});
