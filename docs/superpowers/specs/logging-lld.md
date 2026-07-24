<!--
 Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 SPDX-License-Identifier: BSD-3-Clause
-->

# Logging — Low-Level Design

## Document Information

- **Version**: 2.0
- **Date**: July 2026
- **Status**: Draft
- **Endpoints**:
  - `POST /arc-api/v1/logs` — write a log entry
  - `GET /arc-api/v1/projects/{projectId}/logs` — read log entries for a project

---

## Table of Contents

1. [Scope and Requirements](#1-scope-and-requirements)
2. [New Dependency](#2-new-dependency)
3. [Architecture Overview](#3-architecture-overview)
4. [Database Schema](#4-database-schema)
5. [Transport Layer](#5-transport-layer)
6. [PinoLogService](#6-pinologservice)
7. [Client Log Endpoint](#7-client-log-endpoint)
8. [Read Log Entries Endpoint](#8-read-log-entries-endpoint)
9. [Module Wiring](#9-module-wiring)
10. [Call Flow](#10-call-flow)
11. [Error Handling](#11-error-handling)
12. [Folder Structure](#12-folder-structure)
13. [Logger Propagation Pattern](#13-logger-propagation-pattern)
14. [LogData Field Convention](#14-logdata-field-convention)

---

## 1. Scope and Requirements

Persistent DB logging for the AudioReach Creator Backend. All server-generated log calls and client-submitted log entries are written to the SQLite database, and can be read back per project. Console and file logging are preserved via Pino transports.

### Functional Requirements

**FR-1 — Client log endpoint**

Clients can POST a log entry to the server via REST. The server persists it to the database.

- **Endpoint**: `POST /arc-api/v1/logs`
- Request body: `level`, `description`, `timestamp`, `shortMsg`, `component`, `tag`, `projectId` (optional), `error` (optional, string)
- `clientId` is **not** part of the request body. It is extracted from the JWT in the controller layer (assumed available) and written to the `source` column.
- Returns 200 on success, 400 on validation failure

**FR-2 — Server-side logging to DB**

All server-generated log calls are persisted to the database. This includes logs emitted by: `CommandBus`, `QueryBus`, controllers, exception filters, and middleware.

**FR-3 — All six log levels supported**

`verbose`, `debug`, `info`, `warn`, `error`, `critical` — all persisted to the database for both client-submitted and server-generated log entries.

**FR-4 — Single table for all logs**

All log entries — from all clients and the server — are stored in one table. No per-client or per-project table splitting.

**FR-5 — Log entries survive errors**

A command transaction failure or rollback must not cause log entries from that operation to be lost.

**FR-6 — Multiple clients in parallel**

Multiple clients must be able to submit log entries concurrently without data loss or corruption.

**FR-7 — Read log entries by project**

Clients and internal tools can retrieve log entries for a given project via REST.

- **Endpoint**: `GET /arc-api/v1/projects/:projectId/logs`
- Returns all log entries whose `projectId` matches the path parameter
- Optional `source` query parameter filters results to a single source (a `clientId` or `"Server"`)
- Response is always an array; an empty array is a valid response when no entries match

---

## 2. New Dependency

`pino` must be added to `packages/api/package.json`:

```json
"pino": "^9.x"
```

---

## 3. Architecture Overview

`PinoLogService` is the `'LOGGER'` provider. Pino fans out log calls to three transports: `ConsoleTransport` (stdout), `FileTransport` (log file), and `SQLiteTransport` (DB). A REST endpoint allows clients to submit their own log entries through the same pipeline, and a second REST endpoint allows reading log entries back per project.

```
'LOGGER' token (ArcCqrsModule)
    └── PinoLogService         (implements Logger from @arc/core)
            └── pino.multistream
                    ├── ConsoleTransport   → stdout/stderr
                    ├── FileTransport      → logs/server-debug-*.log
                    └── SQLiteTransport
                            └── PinoSQLiteTransport  (Transform stream)
                                    └── DataSource.query()
                                            └── log_entries table

POST /arc-api/v1/logs
    └── LogController
            └── inject 'LOGGER'  →  PinoLogService  (same pipeline)

GET /arc-api/v1/projects/:projectId/logs
    └── LogQueryController
            └── QueryBus → GetLogsByProjectHandler → LogQueryService
                    └── DataSource.query()  (read from log_entries table)
```

---

## 4. Database Schema

### 4.1 Table: `log_entries`

The log table deliberately does **not** follow `EntityBaseRow`:
- No `system_id` from `EntityIdServiceRegistry` — requiring an ID generator call before every log write adds a DB roundtrip that could fail and lose the entry
- No `version` column — optimistic locking is meaningless on an append-only table
- Uses SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`

```sql
CREATE TABLE IF NOT EXISTS log_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  level       TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  source      TEXT NOT NULL,
  project_id  TEXT,
  component   TEXT NOT NULL,
  tag         TEXT NOT NULL,
  short_msg   TEXT NOT NULL,
  description TEXT NOT NULL,
  error       TEXT
);
```

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | INTEGER PK | no | auto-increment |
| `level` | TEXT | no | `verbose`/`debug`/`info`/`warn`/`error`/`critical` |
| `timestamp` | TEXT | no | ISO-8601 string |
| `source` | TEXT | no | `clientId` for client-submitted logs, literal `"Server"` for server-generated logs. Replaces the old `client_id` column — `client_id` is no longer stored. |
| `project_id` | TEXT | yes | |
| `component` | TEXT | no | |
| `tag` | TEXT | no | |
| `short_msg` | TEXT | no | |
| `description` | TEXT | no | JSON string; exact shape varies by `level` — to be defined later |
| `error` | TEXT | yes | JSON blob — `{ message, stack }` when present |

### 4.2 TypeORM Entity Schema

**File**: `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/entity-schema/logging/log-entry.schema.ts`

```typescript
export interface LogEntryRow {
  id: number;
  level: string;
  timestamp: string;
  source: string;
  projectId?: string;
  component: string;
  tag: string;
  shortMsg: string;
  description: string;
  error?: string;
}

export const LogEntrySchema = new EntitySchema<LogEntryRow>({
  name: 'LogEntry',
  tableName: 'log_entries',
  columns: {
    id:          { type: 'integer', primary: true, generated: 'increment' },
    level:       { name: 'level',       type: 'text', nullable: false },
    timestamp:   { name: 'timestamp',   type: 'text', nullable: false },
    source:      { name: 'source',      type: 'text', nullable: false },
    projectId:   { name: 'project_id',  type: 'text', nullable: true },
    component:   { name: 'component',   type: 'text', nullable: false },
    tag:         { name: 'tag',         type: 'text', nullable: false },
    shortMsg:    { name: 'short_msg',   type: 'text', nullable: false },
    description: { name: 'description', type: 'text', nullable: false },
    error:       { name: 'error',       type: 'text', nullable: true },
  },
});
```

`LogEntrySchema` is added to `getAllEntitySchemas()` and `ENTITY_NAMES` in `entity-table-names.ts`.

---

## 5. Transport Layer

`SQLiteTransport` injects the existing `DataSource` — no separate SQLite database file is created.

### 5.1 Interfaces

**`transport.interface.ts`**:
```typescript
export interface PinoTransportConfig {
  level: string;
  stream: DestinationStream;
}

export interface ITransport {
  create(config: TransportConfig): PinoTransportConfig;
  validate?(config: TransportConfig): boolean;
}
```

**`logger-config.interface.ts`**:
```typescript
export interface LoggerConfig {
  level: string;
  transports: TransportConfig[];
}

export interface TransportConfig {
  transport: ITransport;
  level: string;
  options?: Record<string, any>;
}
```

### 5.2 BaseTransport

Abstract class. Subclasses implement `create()`. Provides `validate()` with level checking.

### 5.3 ConsoleTransport

Writes to `process.stdout` or `process.stderr`.

```typescript
@Injectable()
export class ConsoleTransport extends BaseTransport {
  create(config: TransportConfig): PinoTransportConfig {
    return {
      level: config.level,
      stream: config.options?.useStderr ? process.stderr : process.stdout,
    };
  }
}
```

### 5.4 FileTransport

Writes to a rotating log file via `pino.destination`.

```typescript
@Injectable()
export class FileTransport extends BaseTransport {
  create(config: TransportConfig): PinoTransportConfig {
    const filePath = path.join(
      config.options?.logsDir ?? './logs',
      config.options?.filename ?? 'app.log',
    );
    return {
      level: config.level,
      stream: pino.destination({ dest: filePath, sync: false, mkdir: true }),
    };
  }
}
```

### 5.5 SQLiteTransport

Receives the existing `DataSource` via NestJS injection. Creates a `PinoSQLiteTransport` stream backed by it.

```typescript
@Injectable()
export class SQLiteTransport extends BaseTransport {
  constructor(
    @Inject('DATA_SOURCE') private readonly dataSource: DataSource,
  ) {
    super();
  }

  create(config: TransportConfig): PinoTransportConfig {
    return {
      level: config.level,
      stream: new PinoSQLiteTransport(this.dataSource),
    };
  }
}
```

### 5.6 PinoSQLiteTransport

A Node.js `Transform` stream in object mode. Receives each log entry from Pino, writes to `log_entries` via `DataSource.query()`. Errors are swallowed — a transport failure must never crash the application or block the stream.

```typescript
export class PinoSQLiteTransport extends Transform {
  constructor(private readonly dataSource: DataSource) {
    super({ objectMode: true });
  }

  _transform(chunk: any, _encoding: string, callback: () => void): void {
    const entry = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;

    this.dataSource
      .query(
        `INSERT INTO log_entries
           (level, timestamp, source, project_id, component, tag, short_msg, description, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.level       ?? 'info',
          entry.timestamp   ?? new Date().toISOString(),
          entry.source      ?? 'Server',
          entry.projectId   ?? null,
          entry.component   ?? '',
          entry.tag         ?? '',
          entry.shortMsg    ?? '',
          entry.description ?? '',
          entry.error ? JSON.stringify(entry.error) : null,
        ],
      )
      .then(() => callback())
      .catch(err => {
        console.error('PinoSQLiteTransport insert error:', err);
        callback();
      });
  }

  _flush(callback: () => void): void {
    callback();
  }
}
```

### 5.7 LoggerFactory

```typescript
@Injectable()
export class LoggerFactory {
  createLogger(config: LoggerConfig): pino.Logger {
    const streams = config.transports.map(t => t.transport.create(t));
    return pino({ level: config.level }, pino.multistream(streams));
  }
}
```

---

## 6. PinoLogService

**File**: `packages/api/src/infrastructure-wrapper/logger/pino-log.service.ts`

Implements the `Logger` interface from `@arc/core`. Wraps a `pino.Logger`. All six methods delegate to the corresponding Pino level.

| `Logger` method | Pino level |
|---|---|
| `logVerbose` | `trace` |
| `logDebug` | `debug` |
| `logInfo` | `info` |
| `logWarn` | `warn` |
| `logError` | `error` |
| `logCritical` | `fatal` |

```typescript
@Injectable()
export class PinoLogService implements Logger {
  constructor(
    @Inject('PINO_LOGGER') private readonly pinoLogger: pino.Logger,
  ) {}

  logVerbose(data: LogData): void  { this.pinoLogger.trace(data); }
  logDebug(data: LogData): void    { this.pinoLogger.debug(data); }
  logInfo(data: LogData): void     { this.pinoLogger.info(data); }
  logWarn(data: LogData): void     { this.pinoLogger.warn(data); }
  logError(data: LogData): void    { this.pinoLogger.error(data); }
  logCritical(data: LogData): void { this.pinoLogger.fatal(data); }
}
```

---

## 7. Client Log Endpoint

### 7.1 Endpoint

`POST /arc-api/v1/logs`

### 7.2 Request DTO

**File**: `packages/api/src/presentation/rest/modules/logging/dto/create-log-entry-request.dto.ts`

| Field | Type | Required | Notes |
|---|---|---|---|
| `level` | `LogLevel` | yes | one of the six values |
| `description` | `string` | yes | |
| `timestamp` | `Date` | yes | ISO-8601 |
| `shortMsg` | `string` | yes | |
| `component` | `string` | yes | |
| `tag` | `string` | yes | |
| `projectId` | `string` | no | |
| `error` | `string` | no | serialised error message from client; wrapped in `new Error()` by controller |

`clientId` is not part of this DTO — it is extracted from the JWT in the controller layer (assumed already available) and used to populate `source`.

### 7.3 Controller

**File**: `packages/api/src/presentation/rest/modules/logging/logging.controller.ts`

```typescript
@Controller('arc-api/v1/logs')
export class LogController {
  constructor(@Inject('LOGGER') private readonly logger: Logger) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  log(@Body() dto: CreateLogEntryRequestDto, @ClientId() clientId: string): void {
    const data: LogData = {
      description: dto.description,
      timestamp:   dto.timestamp,
      shortMsg:    dto.shortMsg,
      component:   dto.component,
      tag:         dto.tag,
      source:      clientId,
      projectId:   dto.projectId,
      error:       dto.error ? new Error(dto.error) : undefined,
    };

    switch (dto.level) {
      case LogLevel.Verbose:  this.logger.logVerbose(data);  break;
      case LogLevel.Debug:    this.logger.logDebug(data);    break;
      case LogLevel.Info:     this.logger.logInfo(data);     break;
      case LogLevel.Warn:     this.logger.logWarn(data);     break;
      case LogLevel.Error:    this.logger.logError(data);    break;
      case LogLevel.Critical: this.logger.logCritical(data); break;
    }
  }
}
```

`@ClientId()` extracts the client identifier from the JWT (assumed to already exist as a param decorator — out of scope for this doc). For server-generated logs (Section 10.1), `source` is set to the literal `"Server"` instead.

No `async`/`await` — `Logger` methods return `void`. DB write is fire-and-forget inside `PinoSQLiteTransport`.

---

## 8. Read Log Entries Endpoint

Follows the same CQRS pattern as every other read endpoint in this codebase (e.g. `GetAllKeyDefinitions`): `Controller → QueryBus → Handler → QueryService port → DataSource`.

### 8.1 Endpoint

`GET /arc-api/v1/projects/:projectId/logs`

| Parameter | Location | Type | Required | Notes |
|---|---|---|---|---|
| `projectId` | path | `string` | yes | matched against `log_entries.project_id` |
| `source` | query | `string` | no | matched against `log_entries.source` when provided (e.g. a `clientId` value, or `"Server"`) |

Response is always an array; an empty array is a valid response.

### 8.2 Read model (`@arc/core`)

**File**: `packages/core/src/application/ports/persistence/query-services/logging/log-entry-read-model.ts`

```typescript
export interface LogEntryReadModel {
  readonly id: number;
  readonly level: string;
  readonly description: string;
  readonly timestamp: string;
  readonly shortMsg: string;
  readonly component: string;
  readonly tag: string;
  readonly source: string;
  readonly projectId?: string;
  readonly error?: string;
}
```

### 8.3 Query service port (`@arc/core`)

**File**: `packages/core/src/application/ports/persistence/query-services/logging/log-query-service.ts`

```typescript
export interface LogQueryService {
  getLogsByProject(
    projectId: string,
    source?: string,
  ): Promise<LogEntryReadModel[]>;
}
```

Registered in `QueryServices`:

```typescript
export interface QueryServices {
  // ... existing services ...
  readonly logQueryService: LogQueryService;  // NEW
}
```

### 8.4 Query and Handler (`@arc/core`)

**File**: `packages/core/src/application/logging/get-logs/get-logs-by-project.query.ts`

```typescript
export class GetLogsByProjectQuery extends BaseQuery {
  constructor(
    public readonly projectId: string,
    public readonly source: string | undefined,
    clientId_: string,
  ) {
    super(clientId_);
  }
}
```

**File**: `packages/core/src/application/logging/get-logs/get-logs-by-project.handler.ts`

```typescript
export class GetLogsByProjectHandler implements QueryHandler<
  GetLogsByProjectQuery,
  Promise<LogEntryReadModel[]>
> {
  constructor(private readonly queryServices: QueryServices) {}

  async handle(query: GetLogsByProjectQuery): Promise<LogEntryReadModel[]> {
    return this.queryServices.logQueryService.getLogsByProject(
      query.projectId,
      query.source,
    );
  }
}
```

Registered in `QueryHandlerRegistry.registerAllQueryHandlers()` alongside the other query handlers.

### 8.5 DB implementation (`@arc/persistence`)

**File**: `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/queries/logging/db-log-query-service.ts`

```typescript
export class DbLogQueryService implements LogQueryService {
  constructor(private readonly dataSource: DataSource) {}

  async getLogsByProject(
    projectId: string,
    source?: string,
  ): Promise<LogEntryReadModel[]> {
    let qb = this.dataSource
      .getRepository(ENTITY_NAMES.LogEntry)
      .createQueryBuilder('l')
      .where('l.projectId = :projectId', {projectId});

    if (source !== undefined) {
      qb = qb.andWhere('l.source = :source', {source});
    }

    return qb.getMany() as Promise<LogEntryReadModel[]>;
  }
}
```

No overlay/session logic — `log_entries` is append-only and not subject to edit sessions, unlike domain entities such as `KeyDefinition`.

### 8.6 Controller

**File**: `packages/api/src/presentation/rest/modules/logging/logging.controller.ts` (same controller as the write endpoint)

```typescript
@Controller('arc-api/v1/projects')
export class LogQueryController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get(':projectId/logs')
  async getLogs(
    @Param('projectId') projectId: string,
    @Query('source') source?: string,
  ): Promise<ApiResult<LogEntryResponseDto[]>> {
    const query = new GetLogsByProjectQuery(projectId, source, 'client-id');
    const logs = await this.queryBus.execute<LogEntryReadModel[]>(query);

    return {
      data: logs.map(l => this.mapToDto(l)),
      success: true,
      message: 'Log entries retrieved successfully',
    };
  }

  private mapToDto(log: LogEntryReadModel): LogEntryResponseDto {
    const dto = new LogEntryResponseDto();
    dto.id = log.id;
    dto.level = log.level;
    dto.description = log.description;
    dto.timestamp = log.timestamp;
    dto.shortMsg = log.shortMsg;
    dto.component = log.component;
    dto.tag = log.tag;
    dto.source = log.source;
    dto.projectId = log.projectId;
    dto.error = log.error;
    return dto;
  }
}
```

The write endpoint (`POST /arc-api/v1/logs`) and read endpoint (`GET /arc-api/v1/projects/:projectId/logs`) use different route prefixes (`logs` vs. `projects/:projectId/logs`), per FR-1 and FR-7 above. They can live in the same `LogModule` as two controllers, or the same controller registered under both paths via NestJS's multi-path support — either is acceptable; the folder structure in Section 12 assumes two controller classes for clarity.

---

## 9. Module Wiring

### 9.1 ArcCqrsModule changes

Add transport providers, `LoggerFactory`, `'PINO_LOGGER'` factory, and `PinoLogService` as the `'LOGGER'` provider.

```typescript
// Transport providers
{ provide: ConsoleTransport, useClass: ConsoleTransport },
{ provide: FileTransport,    useClass: FileTransport    },
{
  provide: SQLiteTransport,
  useFactory: (dataSource: DataSource) => new SQLiteTransport(dataSource),
  inject: ['DATA_SOURCE'],
},

// LoggerFactory
{ provide: LoggerFactory, useClass: LoggerFactory },

// Pino logger instance
{
  provide: 'PINO_LOGGER',
  useFactory: (
    factory:          LoggerFactory,
    consoleTransport: ConsoleTransport,
    fileTransport:    FileTransport,
    sqliteTransport:  SQLiteTransport,
  ) =>
    factory.createLogger({
      level: 'trace',
      transports: [
        { transport: consoleTransport, level: 'info'  },
        { transport: fileTransport,    level: 'trace',
          options: { logsDir: './logs', filename: 'server-debug.log' } },
        { transport: sqliteTransport,  level: 'trace' },
      ],
    }),
  inject: [LoggerFactory, ConsoleTransport, FileTransport, SQLiteTransport],
},

// LOGGER token
{
  provide: 'LOGGER',
  useClass: PinoLogService,
},

// Read-side query service
{
  provide: 'LOG_QUERY_SERVICE',
  useFactory: (dataSource: DataSource) => new DbLogQueryService(dataSource),
  inject: ['DATA_SOURCE'],
},
```

`logQueryService` is also added to the `DbQueryServices` constructor (see Section 8.3) so `QueryBus`-dispatched handlers can reach it via `QueryServices`.

### 9.2 LogModule (new)

```typescript
@Module({
  imports: [ArcCqrsModule],
  controllers: [LogController, LogQueryController],
})
export class LogModule {}
```

### 9.3 AppModule

`LogModule` added to `AppModule` imports.

---

## 10. Call Flow

### 10.1 Server log (e.g. CommandBus)

```
CommandBus.logger.logError(data)   // data.source = 'Server'
  └── PinoLogService.logError(data)
        └── pinoLogger.error(data)
              └── pino.multistream
                    ├── ConsoleTransport stream  → stderr
                    ├── FileTransport stream     → logs/server-debug.log
                    └── SQLiteTransport stream
                          └── PinoSQLiteTransport._transform(chunk)
                                └── DataSource.query(INSERT INTO log_entries ...)
                                      └── log_entries table
```

### 10.2 Client log (REST write)

```
POST /arc-api/v1/logs  { level, description, timestamp, ... }
  └── LogController.log(dto, clientId)   // clientId extracted from JWT
        └── build LogData  (source = clientId)
        └── PinoLogService.logInfo(data)   (or whichever level)
              └── pinoLogger.info(data)
                    └── pino.multistream  (same three transports)
```

### 10.3 Read log entries (REST read)

```
GET /arc-api/v1/projects/:projectId/logs?source=...
  └── LogQueryController.getLogs(projectId, source?)
        └── new GetLogsByProjectQuery(projectId, source, 'client-id')
        └── QueryBus.execute(query)
              └── GetLogsByProjectHandler.handle(query)
                    └── queryServices.logQueryService.getLogsByProject(projectId, source?)
                          └── DbLogQueryService.getLogsByProject()
                                └── SELECT * FROM log_entries
                                    WHERE project_id = ? [AND source = ?]
                          └── LogEntryReadModel[]
        └── map to LogEntryResponseDto[]
```

---

## 11. Error Handling

| Layer | Condition | Behaviour | Reason |
|---|---|---|---|
| `LogController` | Invalid request body | `400 Bad Request` — NestJS validation | — |
| `LogController` | Unknown `level` value | `400 Bad Request` — DTO validation | — |
| `PinoSQLiteTransport` | `DataSource.query()` throws | `console.error`, `callback()` called — stream continues, entry is lost silently | Calling `callback()` without an error keeps the stream alive; a logging failure must never crash the app or fail the operation being logged — worst case is one lost log line, not a broken request |
| `PinoSQLiteTransport` | JSON parse error on chunk | `console.error`, `callback()` called — stream continues | Same as above — an unparseable chunk must not stop subsequent log entries from being written |
| `LogQueryController` | No entries match `projectId`/`source` | `200 OK` with empty array — not a 404 | A project or source having no logs yet is a normal, expected state, not an error condition |
| `DbLogQueryService` | Unexpected DB error | Exception propagates — `500 Internal Server Error` via NestJS default filter | — |

---

## 12. Folder Structure

```
packages/api/src/
  infrastructure-wrapper/
    logger/
      pino-log.service.ts                    ← NEW
      transports/
        base-transport.ts                    ← NEW
        console-transport.ts                 ← NEW
        file-transport.ts                    ← NEW
        sqlite-transport.ts                  ← NEW
        pino-sqlite-transport.ts             ← NEW
      interfaces/
        logger-config.interface.ts           ← NEW
        transport.interface.ts               ← NEW
      factories/
        logger.factory.ts                    ← NEW
      index.ts                               ← update exports
    arc-cqrs.module.ts                       ← MODIFY

  presentation/rest/modules/
    logging/
      logging.controller.ts                  ← NEW (write endpoint)
      logging-query.controller.ts            ← NEW (read endpoint)
      logging.module.ts                      ← NEW
      dto/
        create-log-entry-request.dto.ts      ← NEW
        log-entry-response.dto.ts            ← NEW

packages/core/src/
  application/
    logging/
      get-logs/
        get-logs-by-project.query.ts         ← NEW
        get-logs-by-project.handler.ts       ← NEW
    ports/persistence/query-services/
      logging/
        log-entry-read-model.ts              ← NEW
        log-query-service.ts                 ← NEW
      query-services.ts                      ← MODIFY (add logQueryService)
    orchestration/cqrs/registries/
      query-handler-registry.ts              ← MODIFY (register GetLogsByProjectQuery)

packages/infrastructure/persistence/src/
  persistence-typeorm-sqllite/
    entity-schema/
      logging/
        log-entry.schema.ts                  ← NEW
      entity-table-names.ts                  ← MODIFY (add LogEntry)
    queries/
      logging/
        db-log-query-service.ts              ← NEW
      typeorm-query-services.ts              ← MODIFY (wire logQueryService)
```

---

## 13. Logger Propagation Pattern

The `Logger` interface lives in `@arc/core`. The concrete implementation (`PinoLogService`) lives in `@arc/api`. Core and infrastructure never import the implementation — they only import the interface. The concrete instance is passed across package boundaries as a constructor argument, wired by `ArcCqrsModule`.

### 13.1 Package dependency model

| Package | `@arc/core` entry | Can import `Logger`? |
|---|---|---|
| `@arc/core` | owns the interface | ✅ no import needed |
| `@arc/persistence` | `peerDependency` + `devDependency` | ✅ already works today — no change needed |
| `@arc/api` | `dependency` | ✅ direct |

`@arc/persistence` does **not** need `@arc/core` in `dependencies`. The `peerDependency` ensures `@arc/api` provides the shared instance at runtime. `devDependency` makes types available during build. This is the correct setup and must not be changed.

### 13.2 Injection chain — full picture

```
ArcCqrsModule (@arc/api)
  'LOGGER' → PinoLogService
        │
        │  constructor arg: new CommandBus(..., logger)
        ▼
  CommandBus (@arc/core)
    this.logger: Logger
        │
        │  deps.logger passed into createHandler()
        ▼
  Any CommandHandler (@arc/core)
    this.logger?: Logger
        │
        │  constructor arg: new TypeOrmUnitOfWork(..., logger)
        │  (via createTypeOrmUnitOfWorkFactory)
        ▼
  TypeOrmUnitOfWork (@arc/api)
    this.logger?: Logger
        │
        │  constructor arg: new TypeOrmBulkImportRepository(manager, idGen, logger)
        ▼
  TypeOrmBulkImportRepository (@arc/persistence)
    this.logger?: Logger
        │
        │  constructor arg: new DataLinkInserter(manager, logger)
        ▼
  DataLinkInserter (@arc/persistence)
    this.logger?.logInfo(...)   ← Logger interface, Pino invisible
```

`DbQueryServices` already follows this same pattern — `Logger` is passed in via constructor from `ArcCqrsModule` today.

### 13.3 Rule for new handlers and repositories

Any new `CommandHandler` or repository that needs logging:
1. Add `private readonly logger?: Logger` to its constructor — **optional** so existing callers don't break
2. Import `Logger` from `@arc/core`
3. Register the logger in `CommandHandlerRegistry` via `deps.logger`
4. No changes to `package.json` in any package

---

## 14. `LogData` Field Convention

Consistent use of every `LogData` field across all layers is what makes logs filterable and traceable end-to-end for a single feature.

- **`description`** — human-readable description of what happened. Free text, written for a person reading the log, not for filtering.
- **`timestamp`** — when the log event occurred. Always `new Date()` at the call site, not when the entry is eventually persisted by the transport.
- **`source`** — identifies the origin of the log entry: the `clientId` (extracted from the JWT) for client-submitted logs, or the literal `"Server"` for server-generated logs. Propagated from the command/query, not re-derived at the logging call site.
- **`projectId`** — identifies which project/workspace context the operation ran in, when known. Propagated from the request (e.g. `String(query.projectId)`), not looked up again.
- **`shortMsg`** — the specific operation or step within the emitting class, kebab-case (e.g. `get-all-key-definitions`, `get-all-key-definitions-error`). Fine-grained, usually unique per code path.
- **`component`** — the emitting class name, verbatim (e.g. `GetAllKeyDefinitionsHandler`). One value per class.
- **`tag`** — a stable category shared by every layer participating in one feature or call flow (e.g. `key-definition`). Coarse-grained — lets a query like `WHERE tag = 'key-definition'` return every log entry for that feature across controller, handler, and persistence layers regardless of which class emitted it.
- **`error`** — the `Error` object, included only on failure paths (`logError`/`logCritical`, or any level when something recoverable still went wrong). Never fabricated — pass the actual caught error, wrapped with `error instanceof Error ? error : new Error(String(error))` when the caught value isn't guaranteed to be an `Error`.

### 14.1 Worked example — `GetAllKeyDefinitions` call flow

Tracing `GET /arc-api/v1/projects/:projectId/definitions/keys` end to end — `tag` stays `key-definition` at every layer; `shortMsg` narrows to the specific step; `component` identifies the exact class; `source`/`projectId` carry through from the originating query.

**Handler — success path:**

```typescript
this.logger?.logInfo({
  description: `Fetching key definitions for project ${query.projectId}`,
  shortMsg: 'get-all-key-definitions',
  component: 'GetAllKeyDefinitionsHandler',
  tag: 'key-definition',
  timestamp: new Date(),
  source: query.source,
  projectId: String(query.projectId),
});
```

**Persistence — error path:**

```typescript
this.logger?.logError({
  description: 'Failed to load key definitions',
  shortMsg: 'get-all-key-definitions-error',
  component: 'DbKeyValueDefQueryService',
  tag: 'key-definition',
  timestamp: new Date(),
  error: error instanceof Error ? error : new Error(String(error)),
});
```

