import type {SourceColumn} from './LibraryTable';
export interface PropertyDefinition {name:string;type?:string;formula?:string;options?:string[]}
/** Reconcile canonical definitions while retaining each view's column presentation. */
export function mergePropertyColumns(previous:SourceColumn[],definitions:PropertyDefinition[],rename?:{name:string;newName:string}):SourceColumn[]{
 const byName=new Map(definitions.map(d=>[d.name,d]));const used=new Set<string>();
 const result=previous.flatMap(column=>{
  if(!column.id.startsWith('property:'))return [column];
  const name=rename&&column.property===rename.name?rename.newName:column.property!;
  const definition=byName.get(name);if(!definition||used.has(name))return [];used.add(name);
  return [{...column,id:`property:${name}`,property:name,label:name,type:definition.type,formula:definition.formula,options:definition.options}];
 });
 for(const d of definitions)if(!used.has(d.name))result.push({id:`property:${d.name}`,property:d.name,label:d.name,width:150,type:d.type,formula:d.formula,options:d.options});
 return result;
}
