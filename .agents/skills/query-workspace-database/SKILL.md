---
name: query-workspace-database
description: Reads database settings from files in the current workspace and connects before answering a data query. Use when the user asks to 查询数据, 查库, 查表, 取数, run SQL, or fetch business records and a database connection is required.
---

# 从工作区连接数据库并查询

用户要查询数据，且回答依赖数据库中的记录时，先从当前工作区文件读取连接配置，再连接并查询。不要向用户索要已经写在工作区里的主机、库名、账号或密码。

## 读取配置

在工作区根目录执行：

```powershell
python "<skill-base>/scripts/find_db_config.py" --workspace "<工作区根目录>"
```

`<skill-base>` 是本 skill 资源目录。脚本只读工作区里的配置文件，标准输出是一个 JSON。`configs` 已按优先级排好，第一条是默认连接。

没有 `configs` 时，说明工作区里没有可用的数据库配置，并停止。不要编造连接信息，也不要改去读取用户主目录或其他项目。

用户点名了某个库、环境或配置文件时，改用与之匹配的那一条。

## 连接

用选出的那一条连接。密码只用于这一次连接，不要写进回复、日志或新文件。

按引擎选择本机已经安装的客户端：

- `sqlite`：使用 Python 标准库 `sqlite3`。数据文件是相对路径时，相对该配置文件所在目录解析。
- `mysql`、`mariadb`：优先 `pymysql` 或 `mysql.connector`，否则使用 `mysql` 命令。
- `postgres`：优先 `psycopg` 或 `psycopg2`，否则使用 `psql`。
- `sqlserver`：优先 `pyodbc`，否则使用 `sqlcmd`。
- `oracle`：优先 `oracledb`，否则使用 `sqlplus`。

不要安装新的驱动或客户端。现有方式都连不上时，说明配置文件、引擎、主机、库名和失败原因。

## 查询

查询请求只执行读取语句：`SELECT`、`WITH`、`SHOW`、`DESCRIBE`、`EXPLAIN`。给结果加上限制，默认不超过 200 行。

只有用户明确要求写入、改表或删除时，才执行 `INSERT`、`UPDATE`、`DELETE`、`ALTER`、`DROP`、`TRUNCATE`。

## 回复

说明使用的配置文件、引擎、主机和库名，然后给出查询结果。不要回显密码或完整连接串。
