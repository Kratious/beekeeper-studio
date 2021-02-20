import { abstractExportFormat } from "../format";
import { DBConnection, TableOrView, TableFilter } from '../../db/client'

interface OutputOptionsCsv {
    header: boolean,
    delimiter: string
}

export default class CsvExporter extends abstractExportFormat {
    
    constructor(
        fileName: string, 
        connection: DBConnection, 
        table: TableOrView, 
        filters: TableFilter[] | any[], 
        outputOptions: OutputOptionsCsv, 
        progressCallback: (countTotal: number, countExported: number, fileSize: number) => void,
        errorCallback: (error: Error) => void
    ) {
        super(fileName, connection, table, filters, outputOptions, progressCallback, errorCallback)
    }
    
    async getHeader(firstRow: any) {
        if (firstRow && this.outputOptions.header) {
            return Object.keys(firstRow).join(this.outputOptions.delimiter)
        }
    }

    async getFooter() {}

    async writeChunkToFile(data: any) {
        for (const row of data) {
            const content = Object.values(row).join(this.outputOptions.delimiter)
            await this.writeLineToFile(content)
        }
    }
}