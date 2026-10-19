-- 基金金库 · Supabase 建表脚本
-- 用法: 登录 supabase.com → 打开你的项目 → 左侧「SQL Editor」→ 粘贴本文件全部内容 → 点「Run」
-- 说明: 数据本身在浏览器端端到端加密，此表只存密文与密码哈希（与原版 Qoder Sites 设计一致）。

create table if not exists vaults (
  id uuid primary key,
  password_hash text not null,
  encrypted_data text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- 登录按密码哈希查找，加索引
create index if not exists vaults_password_hash_idx on vaults (password_hash);

-- 行级安全策略: 允许匿名密钥读写（应用自身的安全模型是端到端加密 + 密码哈希，
-- 与原版 functions/adapter.mjs 使用 anon key 的方式一致）
alter table vaults enable row level security;
drop policy if exists "vaults anon access" on vaults;
create policy "vaults anon access" on vaults
  for all to anon, authenticated
  using (true)
  with check (true);
