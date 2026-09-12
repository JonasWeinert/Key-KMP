import {describe,it,expect} from 'vitest';
import {mergePropertyColumns} from './property-columns';
describe('canonical property column reconciliation',()=>{
 it('keeps position, width and visibility when a property is renamed',()=>{const result=mergePropertyColumns([{id:'title',label:'Title',width:330},{id:'property:Review',property:'Review',label:'Review',type:'select',width:224,hidden:true,pinned:true}],[{name:'Status',type:'select',options:['Read']}],{name:'Review',newName:'Status'});expect(result[1]).toMatchObject({id:'property:Status',property:'Status',label:'Status',width:224,hidden:true,pinned:true,options:['Read']});});
 it('removes deleted columns and refreshes formula references without disturbing built-ins',()=>{const result=mergePropertyColumns([{id:'title',label:'Title',width:330},{id:'property:Removed',property:'Removed',label:'Removed',width:150},{id:'property:Derived',property:'Derived',label:'Derived',width:170,formula:'{Old}+1'}],[{name:'Derived',type:'formula',formula:'{New}+1'},{name:'Added',type:'text'}]);expect(result.map(c=>c.id)).toEqual(['title','property:Derived','property:Added']);expect(result[1]).toMatchObject({width:170,formula:'{New}+1'});});
});
