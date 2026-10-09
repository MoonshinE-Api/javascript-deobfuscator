import {shortReading} from './clean-junk.js';

const descriptions={fetch:'Ask a server for data or send data to it',sendBeacon:'Send a small message to a server',open:'Open a connection or window',send:'Send data through a connection',setRequestHeader:'Add a header to a request',getItem:'Read a saved value',setItem:'Save a value',getContext:'Get a canvas drawing context',toDataURL:'Turn a canvas drawing into image data',getImageData:'Read pixels from a canvas',getParameter:'Read a graphics setting',getExtension:'Check for a graphics extension',readPixels:'Read pixels from the graphics buffer',encrypt:'Encrypt data',decrypt:'Decrypt data',digest:'Calculate a hash of data',importKey:'Load an encryption key',exportKey:'Export an encryption key',postMessage:'Send a message to another page or worker',importScripts:'Load another script inside a worker',addEventListener:'Listen for an event',Worker:'Start a background worker',SharedWorker:'Start a shared background worker',WebSocket:'Open a live connection to a server'};

export function shortGuide(source,file='src/full-human-readable.js'){
 const {sites}=shortReading(source,file);
 for(const site of sites){site.action=descriptions[site.target.split('.').at(-1)]??'Call a function';site.truncated=site.code.length>=500;site.numberedCode=site.line+': '+site.code;}
 // Excerpts are strings, so this file is valid JavaScript even when the
 // original expression needs private fields, await, or surrounding state.
 const code=['// SHORT READING GUIDE. This does not replace the complete program.',
 '// Each entry describes a possible operation and its exact location in '+file+'.',
 '// A name match is a clue. It does not prove the operation runs or sends personal data.',
 '// Code excerpts below are inert strings; importing this guide does not run them.',
 'export const operations = [',...sites.flatMap(site=>['  {','    action: '+JSON.stringify(site.action)+',','    line: '+site.line+', column: '+site.column+', target: '+JSON.stringify(site.target)+',','    code: '+JSON.stringify(site.code),'  },']),'];',''].join('\n');
 return {code,model:{file:'src/short-human-readable.js',completeFile:file,sites,lines:code.trimEnd().split('\n').length,limit:160,scope:'A short index of recognized calls, in source order. Conditions and callbacks may prevent them from running. Other code remains in the complete program.'}};
}
