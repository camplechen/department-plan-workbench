// 每次请求从当前组织关系计算权限；同级机构人员不因同处一个机构而互见。
export function permissionScope(store,user){
 const organizations=store.sql.prepare('SELECT * FROM organizations ORDER BY name,id').all();
 const memberships=store.sql.prepare('SELECT * FROM user_organizations').all();
 const own=new Set(memberships.filter(m=>m.userId===user.id).map(m=>m.organizationId));
 const descendants=id=>{const found=new Set();const visit=parent=>{for(const o of organizations)if(o.parentId===parent&&!found.has(o.id)){found.add(o.id);visit(o.id);}};visit(id);return found;};
 const subordinateOrgs=new Set([...own].flatMap(id=>[...descendants(id)]));
 const allowed=new Set([user.id,...memberships.filter(m=>subordinateOrgs.has(m.organizationId)).map(m=>m.userId)]);
 const allUsers=store.sql.prepare('SELECT id,displayName,enabled FROM users ORDER BY displayName,id').all();
 const people=allUsers.filter(u=>user.role==='admin'||allowed.has(u.id)).map(u=>({...u,organizationIds:memberships.filter(m=>m.userId===u.id).map(m=>m.organizationId)}));
 const nodes=new Set(user.role==='admin'?organizations.map(o=>o.id):[...own,...subordinateOrgs,...people.flatMap(u=>u.organizationIds)]);
 for(const id of [...nodes]){let parent=organizations.find(o=>o.id===id)?.parentId;while(parent){nodes.add(parent);parent=organizations.find(o=>o.id===parent)?.parentId;}}
 return {people,organizations:organizations.filter(o=>nodes.has(o.id)),canUser:id=>user.role==='admin'||allowed.has(id),canPlan:p=>user.role==='admin'||!!p.ownerUserId&&allowed.has(p.ownerUserId),descendants};
}
export function filterPlans(plans,scope,filters){
 const person=filters.get('ownerUserId'),organization=filters.get('organizationId');
 if(person&&!scope.people.some(u=>u.id===person))return [];
 if(organization&&!scope.organizations.some(o=>o.id===organization))return [];
 const orgIds=organization?new Set([organization,...scope.descendants(organization)]):null;
 return plans.filter(p=>scope.canPlan(p)&&(!person||p.ownerUserId===person)&&(!orgIds||orgIds.has(p.organizationId)));
}
