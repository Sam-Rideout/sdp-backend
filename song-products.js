'use strict';
const PRODUCTS=Object.freeze({VOICE_CLONE:{name:'A Song in Your Voice',price_minor:2399,currency:'CAD'},ORIGINAL_MESSAGE:{name:'Original Song + Your Message',price_minor:1399,currency:'CAD'},ORIGINAL_ONLY:{name:'Original Song',price_minor:899,currency:'CAD'}});
function type(value){const p=value===undefined?'VOICE_CLONE':value;if(!Object.prototype.hasOwnProperty.call(PRODUCTS,p))throw new Error('Unknown song product.');return p;}
function isOriginal(record){return ['ORIGINAL_MESSAGE','ORIGINAL_ONLY'].includes(record?.product_type);}
module.exports={PRODUCTS,type,isOriginal};
