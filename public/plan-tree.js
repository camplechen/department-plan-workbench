// 树筛选只作用于服务端已授权的计划，与搜索和状态筛选叠加。
export function matchesTree(plan,selection,organizations){
 if(!selection)return true;
 if(selection.type==='unassigned')return !plan.ownerUserId;
 if(selection.type==='person')return plan.ownerUserId===selection.id;
 const ids=new Set([selection.id]);
 let changed=true;while(changed){changed=false;for(const node of organizations)if(ids.has(node.parentId)&&!ids.has(node.id)){ids.add(node.id);changed=true;}}
 return ids.has(plan.organizationId);
}
