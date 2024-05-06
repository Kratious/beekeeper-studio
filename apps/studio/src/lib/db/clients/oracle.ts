import { OracleData as D } from '@shared/lib/dialects/oracle';
import knexLib from 'knex';
import oracle from 'bks-oracledb'
import _ from 'lodash'

import { IDbConnectionDatabase, IDbConnectionServer, DatabaseElement } from "../types";
import { BasicDatabaseClient, NoOpContextProvider } from "./BasicDatabaseClient";
import {
  CancelableQuery,
  DatabaseFilterOptions,
  ExtendedTableColumn,
  FieldDescriptor,
  FilterOptions,
  NgQueryResult,
  OrderBy,
  PrimaryKeyColumn,
  SchemaFilterOptions,
  StreamResults,
  TableChanges,
  TableColumn,
  TableFilter,
  TableIndex,
  TableOrView,
  TableProperties,
  TableResult,
  TableTrigger
} from "../models";
import {
  buildSelectQueriesFromUpdates,
  buildInsertQueries,
  buildUpdateQueries,
  withClosable,
  buildDeleteQueries,
  applyChangesSql,
  joinQueries
} from './utils';
import rawLog from 'electron-log'
import { createCancelablePromise, joinFilters } from '@/common/utils';
import { errors } from '@/lib/errors';
import { identify as rawIdentify } from 'sql-query-identifier'
import { IdentifyResult } from 'sql-query-identifier/lib/defines';
import platformInfo from '@/common/platform_info';
import { OracleCursor } from './oracle/OracleCursor';
import { OracleChangeBuilder } from '@shared/lib/sql/change_builder/OracleChangeBuilder';
import { ChangeBuilderBase } from '@shared/lib/sql/change_builder/ChangeBuilderBase';

const log = rawLog.scope('oracle')



export class OracleClient extends BasicDatabaseClient<DriverResult> {
  connectionBaseType = 'oracle' as const;

  pool: oracle.Pool;
  server: IDbConnectionServer
  database: IDbConnectionDatabase
  defaultSchema: () => string
  instantClientLocation: string
  version: string
  readOnlyMode: boolean

  constructor(server: IDbConnectionServer, database: IDbConnectionDatabase) {
    super(knexLib({ client: 'oracledb'}), NoOpContextProvider, server, database);
    this.defaultSchema = ():string => server.config.user.toUpperCase()
    this.instantClientLocation = server.config.instantClientLocation
    this.readOnlyMode = server?.config?.readOnlyMode || false
  }

  getBuilder(table: string, schema?: string): ChangeBuilderBase {
    return new OracleChangeBuilder(table, schema)
  }

  // Create Database

  // AL32UTF8 is Oracle's name for the UTF-8 encoding of the Unicode standard. The Unicode standard is the universal character set that supports most of the currently spoken languages of the world. The use of the Unicode standard is indispensable for any multilingual technology, including database processing.
  // https://docs.oracle.com/en/database/oracle/oracle-database/19/admin/creating-and-configuring-an-oracle-database.html#GUID-2D16B9A8-99A0-48BD-9DFB-FF180EA2CABE
  async listCharsets() {
    return ['AL32UTF8']
  }

  async getDefaultCharset() {
    return 'AL32UTF8';
  }

  async listCollations() {
    return []
  }

  async createDatabase(databaseName, charset) {
    const sql = `CREATE DATABASE ${this.wrapIdentifier(databaseName)} CHARACTER SET ${this.wrapIdentifier(charset)};`
    await this.driverExecuteSingle(sql)
  }

  async importData(insertSQL) {
    await this.driverExecuteMultiple(insertSQL.split(';'))
  }

  getImportSQL (importedData, isTruncate) {
    const { schema, table } = importedData[0]
    const queries = []
    if (isTruncate) {
      queries.push(`TRUNCATE TABLE ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(table)};`)
    }

    queries.push(buildInsertQueries(this.knex, importedData).join(';'))
    return joinQueries(queries)
  }

  createDatabaseSQL() {
    return `
    -- taken from Step 7 of https://docs.oracle.com/cd/B19306_01/server.102/b14231/create.htm#i1008760
    CREATE DATABASE mynewdb
    USER SYS IDENTIFIED BY userid
    USER SYSTEM IDENTIFIED BY userid
    LOGFILE GROUP 1 ('/absolute/path/to/your/logs01.log') SIZE 100M,
            GROUP 2 ('/absolute/path/to/your/logs02.log') SIZE 100M,
            GROUP 3 ('/absolute/path/to/your/logs03.log') SIZE 100M
    MAXLOGFILES 5
    MAXLOGMEMBERS 5
    MAXLOGHISTORY 1
    MAXDATAFILES 100
    MAXINSTANCES 1
    CHARACTER SET US7ASCII
    NATIONAL CHARACTER SET AL16UTF16
    DATAFILE '/absolute/path/to/your/system01.dbf' SIZE 325M REUSE
    EXTENT MANAGEMENT LOCAL
    SYSAUX DATAFILE '/absolute/path/to/your/sysaux01.dbf' SIZE 325M REUSE
    DEFAULT TABLESPACE tbs_1
    DEFAULT TEMPORARY TABLESPACE tempts1
        TEMPFILE '/absolute/path/to/your/temp01.dbf'
        SIZE 20M REUSE
    UNDO TABLESPACE undotbs
        DATAFILE '/absolute/path/to/your/undotbs01.dbf'
        SIZE 200M REUSE AUTOEXTEND ON MAXSIZE UNLIMITED;
    `
  }

  versionString(): string {
    return this.version
  }

  applyChangesSql(changes: TableChanges): string {
    return applyChangesSql(changes, this.knex);
  }

  async applyChanges(changes: TableChanges): Promise<any[]> {

    const insertQueries = buildInsertQueries(this.knex, changes.inserts)
    const updateQueries = buildUpdateQueries(this.knex, changes.updates)
    const deleteQueries = buildDeleteQueries(this.knex, changes.deletes)

    const queries = [...insertQueries, ...updateQueries, ...deleteQueries]

    if (changes.updates) {
      const selectQueries = buildSelectQueriesFromUpdates(this.knex, changes.updates)
      queries.push(...selectQueries)
    }
    const results = await this.driverExecuteMultiple(queries.join(";"))
    const selectResults = changes.updates ? results.slice(results.length - changes.updates?.length, -1) : []
    return selectResults
  }

  getQuerySelectTop(table: string, limit: number, schema?: string): string {
    return `SELECT * from ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(table)} FETCH FIRST ${limit} ROWS ONLY`
  }

  async getTableCreateScript(table: string, schema?: string): Promise<string> {
    const tableQuery = `
      SELECT DBMS_METADATA.GET_DDL('TABLE','${D.escapeString(table)}','${D.escapeString(schema)}') AS TXT FROM DUAL;
    `

    const indexQuery = `
      SELECT DBMS_METADATA.GET_DEPENDENT_DDL('INDEX','${D.escapeString(table)}','${D.escapeString(schema)}') TXT FROM DUAL
    `
    const results = await this.driverExecuteMultiple([tableQuery, indexQuery].join(";"))
    return results.map((r) => r.result.rows[0]).join("\n;\n")
  }
  async getViewCreateScript(view: string, schema?: string): Promise<string[]> {
    const query = `
      SELECT DBMS_METADATA.GET_DDL('VIEW','${D.escapeString(view)}','${D.escapeString(schema)}') AS TXT FROM DUAL;
    `
    const result = await this.driverExecuteSimple(query)
    return [result[0]['TXT']]
  }
  getRoutineCreateScript(_routine: string, _type: string, _schema?: string): Promise<string[]> {
    throw new Error('Method not implemented.');
  }
  truncateAllTables(_schema?: string): void {
    throw new Error('Method not implemented.');
  }
  async listMaterializedViews(_filter?: FilterOptions): Promise<TableOrView[]> {
    return []
  }

  private genOrderByString(orderBy: OrderBy[]) {
    if (!orderBy) return ""

    let orderByString = ""
    if (orderBy && orderBy.length > 0) {
      orderByString = "ORDER BY " + (orderBy.map((item) => {
        if (_.isObject(item)) {
          return `${D.wrapIdentifier(item.field)} ${item.dir.toUpperCase()}`
        } else {
          return D.wrapIdentifier(item)
        }
      })).join(",")
    }
    return orderByString
  }

  private genFilters(filters) {
    let filterString = ""
    if (filters && filters.length > 0) {
      const allFilters = filters.map((item) => {
        if (item.type === 'in') {
          const valuesIn = item.value.map(v => D.escapeString(v, true))
          return `${D.wrapIdentifier(item.field)} IN (${valuesIn.join(',')})`
        } else if (item.type.includes('is')) {
          return `${D.wrapIdentifier(item.field)} ${item.type.toUpperCase()} NULL`
        }
        return `${D.wrapIdentifier(item.field)} ${item.type} ${D.escapeString(item.value, true)}`
      })
      filterString = "WHERE " + joinFilters(allFilters, filters)
    }
    return filterString
  }

  private genSelect(table, offset, limit, orderBy, filters, schema, count = false, selects: string[] = ['*']): string {
    const filterString = _.isString(filters) ?
      `WHERE ${D.wrapLiteral(filters)}` :
      this.genFilters(filters);

    const orderByString = this.genOrderByString(orderBy)

    const schemaString = schema ? `${D.wrapIdentifier(schema)}.` : ''

    const baseSQL = `
      FROM ${schemaString}${D.wrapIdentifier(table)}
      ${filterString}
    `

    const offsetString = (_.isNumber(offset) && _.isNumber(limit)) ?
      `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY` : ''

    // in case we ever start seeing an ORA-00904: Invalid Operator error from the below, check this out for details. https://www.databasestar.com/ora-00904/
    // pretty sure it's covered unless someone goes full wonkadoo
    const selectFormatted = selects.map(s => s === '*' ? '*' : `${D.wrapIdentifier(s)}`)

    const query = `
      SELECT ${count ? 'COUNT(1) as TOTAL' : selectFormatted.join(', ')} ${baseSQL}
      ${orderByString}
      ${offsetString}
    `
    return query
  }


  async selectTopSql(table: string, offset: number, limit: number, orderBy: OrderBy[], filters: string | TableFilter[], schema?: string, selects?: string[]): Promise<string> {
    const query = this.genSelect(table, offset, limit, orderBy, filters, schema, false, selects)
    return query
  }

  async selectTop(table: string, offset: number, limit: number, orderBy: OrderBy[], filters: TableFilter[] | string, schema: string = this.defaultSchema(), selects: string[] = ['*']): Promise<TableResult> {
    const query = this.genSelect(table, offset, limit, orderBy, filters, schema, false, selects)
    const result = await this.driverExecuteSimple(query)
    const fields = Object.keys(result[0] || {})
    return { result, fields }
  }
  async selectTopStream(table, orderBy, filters, chunkSize, schema): Promise<StreamResults> {
    const q = this.genSelect(table, null, null, orderBy, filters, schema)
    const countQ = this.genSelect(table, null, null, orderBy, filters, schema, true)
    log.debug("stream queries", q, countQ)
    const countRes = await this.driverExecuteSimple(countQ)
    const rowCount = countRes[0]['TOTAL']
    const columns = await this.listTableColumns(table, schema)
    return {
      columns: columns,
      totalRows: rowCount,
      cursor: new OracleCursor(this.pool, q, [], chunkSize)
    }
  }
  supportedFeatures = () => ({
    customRoutines: false,
    comments: true,
    properties: true,
    partitions: false,
    editPartitions: false,
    backups: false,
    backDirFormat: false,
    restore: false
  });

  // TODO: implement
  async listRoutines(_filter?: FilterOptions) {
    return []
  }
  // TODO: fix implementation
  async listDatabases(_filter?: DatabaseFilterOptions): Promise<string[]> {
    const current = await this.getCurrentDatabase()
    return [current]
  }

  // this can just return [] always
  listMaterializedViewColumns: (table: string, schema?: string) => Promise<TableColumn[]>;

  listSchemas: (filter?: SchemaFilterOptions) => Promise<string[]>;
  getTableReferences: (table: string, schema?: string) => Promise<string[]>;

  async listTableTriggers(table: string, schema?: string): Promise<TableTrigger[]> {
    const sql = this.knex('ALL_TRIGGERS')
      .select()
      .where('OWNER', schema.toUpperCase())
      .where('TABLE_NAME', table)
      .toQuery()

    const response = await this.driverExecuteSimple(sql)
    return response.map((row) => ({
      name: row.TRIGGER_NAME,
      timing: row.TRIGGER_TYPE,
      manipulation: row.TRIGGERING_EVENT,
      action: row.TRIGGER_BODY,
      condition: null,
      table: row.TABLE_NAME,
      schema: row.TABLE_OWNER
    }))
  }

  async listTableIndexes(table: string, schema?: string): Promise<TableIndex[]> {
    const sql  = `
      select
        INDEX_NAME,
        TABLE_NAME,
        OWNER,
        UNIQUENESS
      from ALL_INDEXES
      WHERE
        TABLE_NAME = ${D.escapeString(table, true)}
        ${schema ? `AND TABLE_OWNER = ${D.escapeString(schema, true)}` : ''}
    `

    const response = await this.driverExecuteSimple(sql)

    const indexes = response.map((row) => row.INDEX_NAME)

    const columnSQL = this.knex('ALL_IND_COLUMNS')
      .whereIn('INDEX_NAME', indexes)
      .select('COLUMN_NAME', 'COLUMN_POSITION', 'DESCEND', 'INDEX_NAME')
      .toQuery()

    const columnResponse = await this.driverExecuteSimple(columnSQL)

    const columnsGrouped = _.chain(columnResponse)
      .sortBy('COLUMN_POSITION')
      .groupBy('INDEX_NAME')
      .value()


    return response.map((row, idx) => ({
      id: idx.toString(),
      table: row.TABLE_NAME,
      schema: row.OWNER,
      name: row.INDEX_NAME,
      unique: row.UNIQUENESS === 'UNIQUE',
      primary: row.INDEX_NAME.startsWith('PK_'),
      columns: columnsGrouped[row.INDEX_NAME]?.map((column) => ({
        name: column.COLUMN_NAME, order: column.DESCEND
      }))
    }))
  }
  async getTableKeys(table: string, schema?: string) {
    // https://stackoverflow.com/questions/1729996/list-of-foreign-keys-and-the-tables-they-reference-in-oracle-db
    const sql = `
    SELECT
      a.table_name,
      a.column_name,
      a.constraint_name,
      c.owner,
      c.delete_rule,
       -- referenced
      c.r_owner,
      c_pk.table_name as R_TABLE_NAME,
      c_pk.constraint_name as R_PK,
      c_pk.owner as R_OWNER,
      r_a.COLUMN_NAME as R_COLUMN
  -- constraint columns
  FROM all_cons_columns a
  -- constraint info for those columns
  JOIN all_constraints c ON a.owner = c.owner
                        AND a.constraint_name = c.constraint_name

  -- information on the columns we're referencing
  JOIN all_constraints c_pk ON c.r_owner = c_pk.owner
                           AND c.r_constraint_name = c_pk.constraint_name

    JOIN all_cons_columns r_a on c_pk.owner = r_a.owner and c_pk.CONSTRAINT_NAME = r_a.CONSTRAINT_NAME
 WHERE c.constraint_type = 'R'
  AND c_pk.constraint_type = 'P'
   AND a.table_name = ${D.escapeString(table.toUpperCase(), true)}
   ${schema ? `AND a.owner = ${D.escapeString(schema.toUpperCase(), true)}` : ''}
    `
    const response = await this.driverExecuteSimple(sql)
    return response.map((row) => ({
      fromTable: row.TABLE_NAME,
      fromSchema: row.OWNER,
      fromColumn: row.COLUMN_NAME,

      toTable: row.R_TABLE_NAME,
      toColumn: row.R_COLUMN,
      toSchema: row.R_OWNER,
      constraintName: row.CONSTRAINT_NAME,
      onDelete: row.DELETE_RULE
    }))
  }


  async getTableProperties(table: string, schema?: string): Promise<TableProperties> {

    const [
      relations,
      indexes,
      triggers,
      owner
    ] = await Promise.all([
      this.getTableKeys(table, schema),
      this.listTableIndexes(table, schema),
      this.listTableTriggers(table, schema),
      Promise.resolve("")
    ])

    return {
      relations, indexes, triggers, owner
    }
  }

  async getPrimaryKey(table: string, schema?: string) {
    const all = await this.getPrimaryKeys(table, schema)
    // we only want single-key tables.
    return all.length === 1 ? all[0].columnName : null
  }

  async getPrimaryKeys(table: string, schema?: string): Promise<PrimaryKeyColumn[]> {

    // don't upper case table names, that's user dependant
    // always upper case owner, because oracle.

    const sql = `
      SELECT
        cols.table_name,
        cols.column_name,
        cols.position,
        cons.status,
        cons.owner
      FROM all_constraints cons, all_cons_columns cols
      WHERE cols.table_name = ${D.escapeString(table, true)}
        ${schema ? `AND cols.owner = ${D.escapeString(schema.toUpperCase(), true)}` : ''}
        AND cons.constraint_type = 'P'
        AND cons.constraint_name = cols.constraint_name
        AND cons.owner = cols.owner
        ORDER BY cols.table_name, cols.position
    `
    const response = await this.driverExecuteSimple(sql)
    const result = response.map((row) => ({
      columnName: row.COLUMN_NAME,
      position: row.POSITION
    }))
    log.debug('primary keys', result)
    return result || []
  }
  async getTableLength(_table: string, _schema?: string): Promise<number> {
    return 0
  }

  wrapIdentifier = D.wrapIdentifier;
  setTableDescription: (table: string, description: string, schema?: string) => Promise<string>;


  platformPath(path?: string): string {
    // see http://oracle.github.io/node-oracledb/doc/api.html#using-initoracleclient-to-set-the-oracle-client-directory
    // why oh why oracle, omg.
    if (!path) return null
    if (platformInfo.isWindows) {
      const regex = /\\/g;
      return path.replaceAll(regex, "\\\\")
    }
    return path
  }

  async getCurrentDatabase(): Promise<string> {
    const result = await this.driverExecuteSimple("SELECT ORA_DATABASE_NAME FROM DUAL");
    return result[0]['ORA_DATABASE_NAME']
  }

  async connect() {
    await super.connect();

    const cliLocation = this.platformPath(this.server.config.instantClientLocation)
    // https://oracle.github.io/node-oracledb/doc/api.html#-152-optional-oracle-net-configuration
    const configLocation = this.platformPath(this.server.config.oracleConfigLocation)


    try {
      const payload = {}
      if (cliLocation) payload['libDir'] = cliLocation
      if (configLocation) payload['configDir'] = configLocation
      oracle.initOracleClient(payload)
      // oracle.initOracleClient()
      oracle.fetchAsString = [oracle.CLOB]
      oracle.fetchAsBuffer = [oracle.BLOB]
    } catch {
      // do nothing
    }

    const connectionMethod = this.server.config.options?.connectionMethod || 'manual'

    let poolConfig = {}
    if (connectionMethod === 'connectionString') {
      poolConfig = {
        connectionString: this.server.config.options.connectionString,
      }
      const { user, password } = this.server.config
      if (user) poolConfig['user'] = user
      if (password) poolConfig['password'] = password
    } else {
      const { host, port, serviceName, ssl } = this.server.config
      const scheme = ssl ? 'tcps://' : ''
      const str = `${scheme}${host}:${port}/${serviceName}`
      poolConfig = {
        user: this.server.config.user,
        password: this.server.config.password,
        connectString: str,
        poolIncrement: 1,
        poolMin: 1,
        poolMax: 4,
      }
    }
    this.pool = await oracle.createPool(poolConfig)
    const vSQL = `
      SELECT BANNER as BANNER FROM v$version
      WHERE BANNER LIKE 'Oracle%';
    `

    this.version = (await this.driverExecuteSimple(vSQL))[0].BANNER
  }
  async checkConnection() {
    // empty on purpose
  }

  async disconnect() {
    await this.pool.close(1);

    await super.disconnect();
  }

  async listTables(filter?: FilterOptions): Promise<TableOrView[]> {
    log.debug("listTables", this.db, filter)
    const builder = this.knex('ALL_TABLES')
    if (filter?.schema) builder.where('OWNER', filter.schema.toUpperCase())
    if (filter?.only) builder.whereIn('TABLE_NAME', filter.only)
    if (filter?.ignore) builder.whereNotIn('TABLE_NAME', filter.ignore)
    const query = builder.select().toQuery()
    const tables = await this.driverExecuteSimple(query)

    return tables.map((row) => {
      return {
        schema: row.OWNER,
        name: row.TABLE_NAME,
        entityType: 'table'
      }
    })
  }

  async dropElement (elementName: string, typeOfElement: DatabaseElement, schema = 'public'): Promise<void> {
    const sql = `DROP ${D.wrapLiteral(typeOfElement)} ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(elementName)}`

    await this.driverExecuteSingle(sql)
  }

  async truncateElement (elementName: string, typeOfElement: DatabaseElement, schema = 'public'): Promise<void> {
    const sql = `TRUNCATE ${D.wrapLiteral(typeOfElement)} ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(elementName)}`

    await this.driverExecuteSingle(sql)
  }

  async duplicateTable(tableName: string, duplicateTableName: string, schema: string): Promise<void> {
    const sql = this.duplicateTableSql(tableName, duplicateTableName, schema);

    await this.driverExecuteSingle(sql);
  }

  duplicateTableSql(tableName: string, duplicateTableName: string, schema: string): string {
    const sql = `
      CREATE TABLE ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(duplicateTableName)} AS
      SELECT * FROM ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(tableName)}
    `;

    return sql;
  }

  async listViews(filter?: FilterOptions): Promise<TableOrView[]> {
    const q = this.knex('ALL_VIEWS').select()
    if (filter?.schema) q.where('OWNER', filter.schema.toUpperCase())
    if (filter?.only) q.whereIn('VIEW_NAME', filter.only)
    if (filter?.ignore) q.whereIn('VIEW_NAME', filter.ignore)

    const views = await this.driverExecuteSimple(q.toQuery())
    return views.map((row) => {
      return {
        schema: row.OWNER,
        name: row.VIEW_NAME,
        entityType: 'view'
      }
    })
  }

  async listTableColumns(table?: string, schema?: string): Promise<ExtendedTableColumn[]> {
    log.debug("listTableColumns", this.db, table, schema)
    let query = this.knex('ALL_TAB_COLS').select()

    if (table) query = query.where('TABLE_NAME', table)
    if (schema) query = query.where('OWNER', schema.toUpperCase())

    const all = await this.driverExecuteSimple(query.toQuery())

    const result = all.map((row) => {
      return {
        ordinalPosition: row.COLUMN_ID,
        schemaName: row.OWNER,
        columnName: row.COLUMN_NAME,
        tableName: row.TABLE_NAME,
        dataType: this.parseDataType(row.DATA_TYPE, row.CHAR_LENGTH),
        nullable: row.NULLABLE === 'Y',
        defaultValue: this.parseDefault(row.DATA_DEFAULT),
        hasDefault: !_.isNil(this.parseDefault(row.DATA_DEFAULT)),
        generated: row.VIRTUAL_COLUMN === 'YES',
      }
    })
    return _.sortBy(result, 'ordinalPosition')
  }

  private parseDefault(dataDefault: string | null | undefined) {
    if (!dataDefault) return null
    return dataDefault.trimEnd()
  }
  private parseDataType(dataType: string, charLength: number) {
    if (!charLength) return dataType
    if (dataType === 'TEXT') return dataType
    return `${dataType}(${charLength})`
  }

  query(text: string): CancelableQuery {
    let canceling = false
    let connection = null
    const cancelable = createCancelablePromise(errors.CANCELED_BY_USER)
    const getConnection = () => this.pool.getConnection()
    return {
      execute: (async () => {
        connection = await getConnection()
        try {
          const data = await Promise.race([
            cancelable.wait(),
            await this.driverExecuteMultiple(text)
          ])
          if (!data) return []
          return this.parseResults(data)
        } catch (err) {
          if (canceling) {
            console.warn('user cancelled query execution')
          } else {
            if (err.message?.includes("table or view does not exist")) {
              err.message = `${err.message} - have you tried "quoting" the table name?`
            }
            throw err
          }
        } finally {
          cancelable.discard()
        }
      }).bind(this),
      cancel: (async () => {
        canceling = true
        if (connection) await connection.break()
        else cancelable.cancel()
      }).bind(this)
    }
  }

  async queryStream(query: string, chunkSize: number): Promise<StreamResults> {
    return {
      totalRows: undefined,
      columns: undefined,
      cursor: new OracleCursor(this.pool, query, [], chunkSize)
    }
  }

  async executeQuery(query: string): Promise<NgQueryResult[]> {
    const results = await this.driverExecuteMultiple(query)
    return this.parseResults(results)
  }

  private parseResults(results: DriverResult[]) {

    return results.map((result) => {
      return this.parseResult(result)
    })
  }

  private parseResult(result: DriverResult): NgQueryResult {

    const fields = this.metaToFields(result.result.metaData)
    const fieldIds = fields?.map((f) => f.id) || []
    return {
      command: result.info.text,
      rowCount: result.result.rows?.length || 0,
      affectedRows: result.result.rowsAffected || 0,
      rows: result.result.rows?.map((r: any) => _.zipObject(fieldIds, r)) || [],
      fields: this.metaToFields(result.result.metaData)
    }
  }


  private metaToFields(metaData?: oracle.Metadata<unknown>[]): FieldDescriptor[] {
    return metaData?.map((meta, idx) => ({
      name: meta.name, id: `c${idx}`, dataType: meta.dbTypeName
    })) || []
  }

  private maybeStripSemicolon(query: string, i: IdentifyResult): string {
    let queryText = query
    if (i.executionType !== 'ANON_BLOCK') {
      queryText = queryText.trimEnd().endsWith(';') ? queryText.trimEnd().slice(0, -1) : queryText
    }
    return queryText
  }

  private async driverExecuteSimple(query) {
    const {result} = await this.driverExecuteSingle(query)
    const allRows = []
    result.rows.forEach((r: any[]) => {
      const nuRow = {}
      r.forEach((item, idx) => {
        const field = result.metaData[idx].name
        nuRow[field] = item
      })
      allRows.push(nuRow)
    })
    return allRows
  }

  protected async rawExecuteQuery(query: string, options: any): Promise<DriverResult | DriverResult[]> {
      const realQueries: string[] = _.isArray(query) ? query : [query]
      const infos = _.flatMap(realQueries.map((q) => this.identify(q)))
      // TODO - use `executeMany` if no SELECT queries are present
      // const hasListing = !!infos.find((i) => ['LISTING', 'UNKNOWN'].includes(i.executionType))
      const c = await this.pool.getConnection()
      return await withClosable(c, async (c: oracle.Connection) => {
        const results: DriverResult[] = []
        for (let qi = 0; qi < infos.length; qi++) {
          const q: IdentifyResult = infos[qi];
          // remove the semicolon, because Oracle, but not for blocks....also because oracle.
          const queryText = this.maybeStripSemicolon(q.text, q)
          log.debug("Execute Query", queryText, options)
          const data = await c.execute(queryText, {})

          results.push({ result: data, info: q})
        }
        await c.commit()
        return results
      })
  }

  private identify(query: string): IdentifyResult[] {
    return rawIdentify(query, {strict: false, dialect: 'oracle'})
  }
}


// interface MultiResult

interface DriverResult {
  result: oracle.Result<unknown>,
  info: IdentifyResult
}
