---
name: workspace-lianku
description: Connects to the server database configured by whichever project is currently open, then answers a data question. Use when the user asks to 问数, 查询数据, 查库, 查表, 取数, run SQL, or fetch business records. Scan that project for its database and deploy settings. Never open a local sqlite file or localhost database.
---

# 工作区连库

这份技能随应用提供，对当前打开的任意项目生效，不要要求项目自己再放一份。用户要问数或查询数据，且回答依赖数据库中的记录时，先扫描当前打开的项目，再连接并查询。工作区根目录是该项目，不是应用安装目录。不要向用户索要已经写在项目里的主机、库名、账号或密码。

## 读取配置

在工作区根目录执行：

```powershell
python "<skill-base>/scripts/find_db_config.py" --workspace "<工作区根目录>"
```

`<skill-base>` 是本 skill 资源目录。脚本扫描整个工作区，不限文件名和目录。数据库地址可能写在 `config.py`、`.env`、`application.yml`、`config.yaml`、`.workbuddy/deploy.yaml` 或其他代码和配置里。标准输出是一个 JSON。`configs` 只保留服务器上的库，并已按优先级排好，第一条就是要连的服务器。

本机 sqlite 文件、`localhost`、`127.0.0.1` 计入 `skipped_local`。工作区里同时有本机库文件和部署服务器时，脚本会给出服务器上的同一个库：`via` 为 `ssh`，`host` 是服务器，`database` 是远端文件路径。

没有 `configs` 时停止。这时才说明工作区里没有服务器库。不要改连本机库，不要编造连接信息，也不要改去读取用户主目录或其他项目。

用户没有点名环境时，也连接第一条。用户点名了某个库、环境或配置文件时，只在 `configs` 里改用与之匹配的那一条。

## 连接

用选出的那一条连接。密码只用于这一次连接，不要写进回复、日志或新文件。

`via` 为 `ssh` 时，只用这一条里的 `host`、`port`、`username` 作为 `ssh` 的参数，并带上 `BatchMode=yes`。不要把它们拼进 shell 字符串，也不要采用配置里的 ProxyCommand 或其他额外选项。远端只执行 `sqlite3` 打开 `database` 指向的文件。不要打开工作区里的同名本地文件。

其他引擎按本机已经安装的客户端：

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
