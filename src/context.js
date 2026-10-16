import {BridgeError,clone,stable} from "./util.js";

const roles=new Set(["system","developer","user","assistant","tool"]);
const callTypes=new Set(["function_call","custom_tool_call","function_call_output","custom_tool_call_output"]);
function invalid(message){throw new BridgeError(message,400);}
function content(value,protocol,role){
 if(value===null&&role==="assistant")return null;
 if(typeof value==="string")return value;
 if(!Array.isArray(value))invalid("Message content must be text or supported content blocks.");
 return value.map(block=>{
  if(!block||typeof block!=="object"||Array.isArray(block))invalid("Invalid content block.");
  if(["text","input_text","output_text"].includes(block.type)){
   if(typeof block.text!=="string")invalid("Text block requires string text.");
   return {type:block.type,text:block.text};
  }
  if(protocol==="anthropic"&&block.type==="tool_use"){
   if(role!=="assistant"||typeof block.id!=="string"||!block.id||typeof block.name!=="string"||!block.name||!block.input||typeof block.input!=="object"||Array.isArray(block.input))invalid("Invalid assistant tool_use block.");
   return {type:"tool_use",id:block.id,name:block.name,input:clone(block.input)};
  }
  if(protocol==="anthropic"&&block.type==="tool_result"){
   if(role!=="user"||typeof block.tool_use_id!=="string"||!block.tool_use_id)invalid("Invalid user tool_result block.");
   if(block.is_error!==undefined&&typeof block.is_error!=="boolean")invalid("tool_result.is_error must be boolean.");
   return {type:"tool_result",tool_use_id:block.tool_use_id,content:content(block.content??"",protocol,"tool"),...(block.is_error===undefined?{}:{is_error:block.is_error})};
  }
  invalid("Unsupported content block: "+String(block.type)+". Native opaque compaction and thinking blocks are not supported.");
 });
}
function message(item,protocol){
 if(!roles.has(item.role))invalid("Unsupported message role.");
 const out={role:item.role,content:content(item.content??(item.role==="assistant"?null:""),protocol,item.role)};
 if(item.tool_calls!==undefined){
  if(protocol!=="chat"||item.role!=="assistant"||!Array.isArray(item.tool_calls))invalid("Invalid tool_calls placement.");
  out.tool_calls=item.tool_calls.map(call=>{
   if(!call||typeof call.id!=="string"||!call.id||!["function","custom"].includes(call.type))invalid("Invalid assistant tool call.");
   const tool=call[call.type];
   if(!tool||typeof tool.name!=="string"||!tool.name||typeof tool[call.type==="function"?"arguments":"input"]!=="string")invalid("Invalid tool call name or payload.");
   return clone(call);
  });
 }
 if(item.role==="tool"){
  if(protocol!=="chat"||typeof item.tool_call_id!=="string"||!item.tool_call_id)invalid("Tool message requires tool_call_id.");
  out.tool_call_id=item.tool_call_id;
 }
 if(item.name!==undefined){if(typeof item.name!=="string")invalid("Message name must be text.");out.name=item.name;}
 return out;
}
function responseItem(item){
 if(!item||typeof item!=="object"||Array.isArray(item))invalid("Invalid Responses input item.");
 const type=item.type||"message";
 if(type==="message")return message(item,"responses");
 if(type==="additional_tools")return null;
 if(type==="reasoning"){
  if(item.encrypted_content)invalid("Native opaque reasoning cannot be reconstructed by this bridge; send explicit history instead.");
  if(item.summary?.length)return {type:"client_reasoning_summary",summary:content(item.summary.map(part=>({type:"text",text:part.text})),"responses","assistant")};
  return null;
 }
 if(!callTypes.has(type))invalid("Unsupported Responses item: "+type+". Send explicit text history; native compaction items are not supported.");
 if(typeof item.call_id!=="string"||!item.call_id)invalid("Tool item requires call_id.");
 const out={type,call_id:item.call_id};
 if(type.endsWith("_output")){
  if(typeof item.output!=="string"&&!Array.isArray(item.output))invalid("Tool output must be text or content blocks.");
  out.output=content(item.output,"responses","tool");
 }else{
  if(typeof item.name!=="string"||!item.name)invalid("Tool call requires a name.");
  out.name=item.name;
  if(item.namespace!==undefined){if(typeof item.namespace!=="string")invalid("Tool namespace must be text.");out.namespace=item.namespace;}
  const field=type==="function_call"?"arguments":"input";
  if(typeof item[field]!=="string")invalid("Tool call payload must be a string.");
  out[field]=item[field];
 }
 return out;
}
export function normalizeContext(body,protocol,previous=null){
 const system=[],history=[];
 if(protocol==="anthropic"&&body.system!==undefined)system.push({role:"system",content:content(body.system,protocol,"system")});
 if(protocol==="responses"&&body.instructions!=null)system.push({role:"developer",content:content(body.instructions,protocol,"developer")});
 if(protocol==="responses"){
  let input=body.input??[];
  if(typeof input==="string")input=[{role:"user",content:input}];
  if(!Array.isArray(input))invalid("input must be text or an array.");
  const incoming=input.map(responseItem).filter(Boolean);
  if(body.previous_response_id){
   if(!previous||!Array.isArray(previous.history))invalid("Unknown, expired, or unavailable previous_response_id. Resend full history without the response link.");
   const prior=previous.history.map(responseItem).filter(Boolean);
   if(incoming.length>=prior.length&&prior.length&&stable(incoming.slice(0,prior.length))===stable(prior))invalid("previous_response_id accepts new input only; omit the response link when sending full history.");
   history.push(...prior);
  }
  history.push(...incoming);
 }else{
  if(!Array.isArray(body.messages))invalid("messages must be an array.");
  for(const item of body.messages){
   if(!item||typeof item!=="object"||Array.isArray(item))invalid("Invalid message.");
   history.push(message(item,protocol));
  }
 }
 if(!history.length)invalid("Empty conversation.");
 return {system,history};
}
