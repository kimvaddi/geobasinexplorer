import { randomUUID } from "node:crypto";
import { WITHHELD_SOURCES } from "@/lib/licence";
import { cfg } from "../config";
import { LICENCE } from "../licence";
import { sha256Of } from "../scan-verdict";
import { LIVE_TABLES, LIVE_QUEUES, SOURCE_REGISTRY_DEFAULTS, validateRegistrySource, type SourceRegistry, type SourceRegistryRow } from "./contracts";
import { PHASE1A_V1_DOC_IDS } from "./source-policy";
import { PIPELINE_TABLES, PIPELINE_LIMITS, PipelineError, statusOf } from "./pipeline-config";
import type { PipelineStore, Row } from "./pipeline-store";

export const SOURCE_ARTIFACTS = {
  "ga-147461": { name: "147461_00_0.zip", sha256: "e5c732cfdc9b07dce94a84587d09b20013d579ef0138fb6b7708907b8be14515", url: "https://d28rz98at9flks.cloudfront.net/147461/147461_00_0.zip" },
  "peps-sa-marabooka-1": { name: "Marabooka1_report.pdf", sha256: "8497dcde6fcb8006f1c1e73f11c42aaf05b2cd96083a59941eec449f13ff6394", url: "bundle-copy" },
  // Later sources. The GA hashes match both the bundle copies and the publisher's files (checked 4 Nov 2026); the Habanero 1
  // archive is rebuilt byte-for-byte from the bundle by pipeline/bundle_habanero.py.
  "ga-147459": { name: "147459_00_0.zip", sha256: "2804f48a92d1286946e09003d3ff4dc8229b9614db15d53f4ac74c4aea0bfed6", url: "https://d28rz98at9flks.cloudfront.net/147459/147459_00_0.zip" },
  "ga-147460": { name: "147460_00_0.zip", sha256: "50038beb15f5e585e801281eed54c20cd622685e6b8f9dcdbc456d660a8f825f", url: "https://d28rz98at9flks.cloudfront.net/147460/147460_00_0.zip" },
  "ga-147462": { name: "147462_00_0.zip", sha256: "fec90e1ad194ee0d391ffd98a2a2c65c88787cc6ac89ceb0cd74a10d6baa4ca0", url: "https://d28rz98at9flks.cloudfront.net/147462/147462_00_0.zip" },
  "peps-sa-habanero-1": { name: "habanero-1-pdfs.zip", sha256: "7a263c058ec7f20d23648daa392651aac05f2fa8fd1334af833c112ec9c265e9", url: "bundle-copy" },
  // Wave 1 national sources. The documents are Geoscience Australia's own files, hashed on 4 Nov 2026. Each catalogue
  // record is rendered from eCat (catalogue-ecat.ts) and registered under its persistent identifier; its pin is the
  // render of the record revision current on 4 Nov 2026, so a later revision lands only after a reviewed re-pin.
  "ga-144233": { name: "144233_00_0.pdf", sha256: "06c2a4b92eec8c00f95f12ed0802b0dc0eb66cf32adc30248dc19d244e6781b4", url: "https://d28rz98at9flks.cloudfront.net/144233/144233_00_0.pdf" },
  "ga-133023-points": { name: "133023_12_0.pdf", sha256: "de273c31ee419fd4527620d6c2823d34d56302cf0cffc54588a27f939379bcaf", url: "https://d28rz98at9flks.cloudfront.net/133023/133023_12_0.pdf" },
  "ga-145744": { name: "AusAEM_Eastern_Resources_Corridor_Data_Release_Summary.pdf", sha256: "594edd881247e8b82f5f4f12e1287fc65e026947c3514b749ec7c740d11f395c", url: "https://d28rz98at9flks.cloudfront.net/145744/Exploring_for_the_Future_AusAEM_East%20Resources_Corridor_Data_Release_Summary.pdf" },
  "ga-147688": { name: "AusAEM_WesternResources_Corridor_data_Release_Summary.pdf", sha256: "1921e0ccada1d48dd332717ab2dfda2d4cca194c2a9857ae70981c04162dc601", url: "https://d28rz98at9flks.cloudfront.net/147688/AusAEM_WesternResources_Corridor_data_Release_Summary.pdf" },
  "ga-146380": { name: "146380_00_0.pdf", sha256: "5825c12e37a55f20b0d10839040d49a4d074018f8c3d8dcdfcd322c96a88634f", url: "https://d28rz98at9flks.cloudfront.net/146380/146380_00_0.pdf" },
  "ga-81486": { name: "Jou1997_v17_n1_p145.pdf", sha256: "c8938db9611a9c1ac45db67306e3b39ca64811ad99069423cc5af6765d0e58a2", url: "https://d28rz98at9flks.cloudfront.net/81486/Jou1997_v17_n1_p145.pdf" },
  "ga-ecat-133023": { name: "ecat-133023-record.pdf", sha256: "74355c6f571d04234109ff077f45a104aedc448a7515500df21c64e6f3d38b4d", url: "https://pid.geoscience.gov.au/dataset/ga/133023" },
  "ga-ecat-145744": { name: "ecat-145744-record.pdf", sha256: "cfdc9d9320105815eb0d21a8b5ffea28b8eb9e49727d66efd3dab00786e1ff81", url: "https://pid.geoscience.gov.au/dataset/ga/145744" },
  "ga-ecat-147688": { name: "ecat-147688-record.pdf", sha256: "af3fee1603e977da06b8642df0e30bf5bb9c0fafaf300b84cb669e6423338605", url: "https://pid.geoscience.gov.au/dataset/ga/147688" },
  "ga-ecat-148588": { name: "ecat-148588-record.pdf", sha256: "eb034a5f910a308a83dec26c5605afe46015f1a4f3a9d6456cb7c1dc6a73c5ac", url: "https://pid.geoscience.gov.au/dataset/ga/148588" },
  "ga-ecat-67240": { name: "ecat-67240-record.pdf", sha256: "5aac8712237cf4fe83003fdc70de5565644d8245943268b18f673933bddbcd11", url: "https://pid.geoscience.gov.au/dataset/ga/67240" },
  "ga-ecat-65388": { name: "ecat-65388-record.pdf", sha256: "d511150b6eb826b897a15c78bfcc3cc6fb778d2a15b6150b2c85a2ceec951912", url: "https://pid.geoscience.gov.au/dataset/ga/65388" },
  "ga-ecat-126310": { name: "ecat-126310-record.pdf", sha256: "f6fd8dbf745a20ba5e9d3533a715ac1ea2b8130ce6262b13f701878f6cc4420e", url: "https://pid.geoscience.gov.au/dataset/ga/126310" },
  "ga-ecat-100520": { name: "ecat-100520-record.pdf", sha256: "302676f6494380d15c04659444910caeaf7b66169290206460af393b0c8a66fe", url: "https://pid.geoscience.gov.au/dataset/ga/100520" },
  // Wave 2 national sources (owner request to prepare, 5 Nov 2026), hashed on 5 Nov 2026. A `member` is one PDF read out of
  // the publisher's archive at `url` by byte-range requests (archive-member.ts), so a data package of up to 4 GB is never
  // downloaded whole; its pin is the member's own SHA-256. A `maxBytes` raises the 60 MB bound for one publisher file, up to
  // PIPELINE_LIMITS.maxSourceBytes; the two GA Records it applies to are 77 and 111 MB.
  // Honeysuckle Creek TEMPEST AEM survey, Victoria, 2001.
  "ga-74123-userguide": { name: "Userguide_HoneysuckleCreek_GIS.pdf", sha256: "f075aa27a02b92f6c52647e1dd3d8e9219c2f71f42faba95ec47e4a6159bbfd8", url: "https://d28rz98at9flks.cloudfront.net/74123/Userguide_HoneysuckleCreek_GIS.pdf" },
  "ga-74123-inversion": { name: "HSK_Inversion_Report.pdf", sha256: "016b55d46d82411d9f0ef9772ddb82a449de10a5ee6937d3c017f6d467774519", url: "https://d28rz98at9flks.cloudfront.net/74123/reports.zip", member: "reports/HSK_Inversion_Report.pdf" },
  "ga-74123-fugro": { name: "HSK_Fugro_AEM_Report_Job_903.pdf", sha256: "903a59d16e46ee8419246d619f110e55664953993a73f47fdf50037cc711aba6", url: "https://d28rz98at9flks.cloudfront.net/74123/reports.zip", member: "reports/HSK_Fugro_AEM_Report_Job_903.pdf" },
  "ga-74123-metadata": { name: "HSK_Geophysics_Metadata.pdf", sha256: "eb097699c3c1bed211ef59716039caa43ef47640911969ad75332e2b54a7af8b", url: "https://d28rz98at9flks.cloudfront.net/74123/reports.zip", member: "reports/HSK_Geophysics_Metadata.pdf" },
  "ga-ecat-74123": { name: "ecat-74123-record.pdf", sha256: "f58b91dd4a3a93a8346362ceb52405ea7fa8c9101fad0986dbb07184f939f7aa", url: "https://pid.geoscience.gov.au/dataset/ga/74123" },
  "ga-ecat-65384": { name: "ecat-65384-record.pdf", sha256: "132013a513577ed71bb1b01bf13d90bcc6a65ad59c1b5762b5de67b8adb98705", url: "https://pid.geoscience.gov.au/dataset/ga/65384" },
  "ga-ecat-84308": { name: "ecat-84308-record.pdf", sha256: "3dd4546c825b587e297669b97bfa685e9d3f848547efeb1216c8ee305191715e", url: "https://pid.geoscience.gov.au/dataset/ga/84308" },
  // AusAEM inversion products.
  "ga-132709": { name: "132709_00_1.pdf", sha256: "9e8289be6a2a0ea6fcf81c51badaf8a161b6707bab2e7a795186b472071674d2", url: "https://d28rz98at9flks.cloudfront.net/132709/132709_00_1.pdf" },
  "ga-ecat-132709": { name: "ecat-132709-record.pdf", sha256: "73102acd9927a67e52f0697a26268174347db466fdf01e1f240ff273930168d7", url: "https://pid.geoscience.gov.au/dataset/ga/132709" },
  "ga-149375": { name: "149375_00_0.pdf", sha256: "cbed8986f6c51bd5c2a93e2143afd9d9dd18bc3c5f4a758b5f6d22ce4932cb29", url: "https://d28rz98at9flks.cloudfront.net/149375/149375_00_0.pdf" },
  "ga-ecat-149375": { name: "ecat-149375-record.pdf", sha256: "5b458822955c68d5a80c1394a1f74217cbd14e1c5df3f54c3f049a5f939d47e8", url: "https://pid.geoscience.gov.au/dataset/ga/149375" },
  // Isostatic residual gravity.
  "ga-145984-report": { name: "IsostaticResidualAustraliaReport_2111.pdf", sha256: "85705359fea26d011f0c7e32d6446e7e4856271a873fad0946a3bd686f4de5ef", url: "https://d28rz98at9flks.cloudfront.net/145984/145984_00_0.zip", member: "IsostaticResidualAustraliaReport_2111.pdf" },
  "ga-ecat-145984": { name: "ecat-145984-record.pdf", sha256: "1ca5a010a78402bcfe1ce74a773f95bf86dd3e97106d39c4e7cc63c5b74f3f6d", url: "https://pid.geoscience.gov.au/dataset/ga/145984" },
  "ga-ecat-144778": { name: "ecat-144778-record.pdf", sha256: "f92fb97518ce715f9183d8232d8b11f2e6996874140940fec7d9351c71977cd4", url: "https://pid.geoscience.gov.au/dataset/ga/144778" },
  "ga-ecat-144775": { name: "ecat-144775-record.pdf", sha256: "d4dbc1bcfa571f1b8f7be773db3f105b11fc78dd855f3e5510762603d555b057", url: "https://pid.geoscience.gov.au/dataset/ga/144775" },
  "ga-ecat-144783": { name: "ecat-144783-record.pdf", sha256: "2a9acdd1c6ee96ac5a12b5eea0f72ab79d7d8b912c537d32d76e8afb66e00583", url: "https://pid.geoscience.gov.au/dataset/ga/144783" },
  "ga-144414": { name: "144414_00_1.pdf", sha256: "6d7ae53dcff0d142733445b4e498dea5ad33fc128a8bca46b83ba43325041794", url: "https://d28rz98at9flks.cloudfront.net/144414/144414_00_1.pdf" },
  "ga-ecat-144414": { name: "ecat-144414-record.pdf", sha256: "64f3e7e53d44ae7c367894d8ec07527f7b39f5f088f4efb7918e85388d9f6660", url: "https://pid.geoscience.gov.au/dataset/ga/144414" },
  // River Murray Corridor RESOLVE and Lower Macquarie River TEMPEST surveys.
  "ga-67212-fugro": { name: "RMC_fugro_final_report.pdf", sha256: "f8befc691a081f79b54c203b7982878f868e3de4fba3d8572bfdac2d888558d4", url: "https://d28rz98at9flks.cloudfront.net/67212/67212.zip", member: "67212/RMC_fugro_final_report.pdf" },
  "ga-ecat-67212": { name: "ecat-67212-record.pdf", sha256: "fecda587df24de5694057d42e4cf2c94c7eb70c690723317a6a1629dcfe6f593", url: "https://pid.geoscience.gov.au/dataset/ga/67212" },
  "ga-68792-methodology": { name: "RMC_Methodology_Report_FINAL.pdf", sha256: "58f51e321ca801ebdc243b37f649869cadfc932c0a42d15122257c10f3e0577d", url: "https://d28rz98at9flks.cloudfront.net/68792/reports.zip", member: "reports/methodology/RMC_Methodology_Report_FINAL.pdf" },
  "ga-68792-userguide": { name: "Userguide_Speewa_GIS.pdf", sha256: "718a671a40551af08555d10d7746d2c197ed667d15122ab75bfbdc4c4c956b31", url: "https://d28rz98at9flks.cloudfront.net/68792/reports.zip", member: "reports/Userguide_Speewa_GIS.pdf" },
  "ga-ecat-68792": { name: "ecat-68792-record.pdf", sha256: "5558ec485f1265b89eadf9b89d130d2e79349c4d06be00772732ca8af78a32e4", url: "https://pid.geoscience.gov.au/dataset/ga/68792" },
  "ga-67211-report": { name: "Lower_Macquarie_River_Report.pdf", sha256: "cd5def535cd3c496e4f04db603edb3f49e928b1a8415256df288052ac2f02911", url: "https://d28rz98at9flks.cloudfront.net/67211/67211.zip", member: "67211/Lower_Macquarie_River_Report.pdf" },
  "ga-ecat-67211": { name: "ecat-67211-record.pdf", sha256: "e926fbceaf8a6a65e09e79bc549b0704dcba4b1be96fc8fe53204cb04883b4a6", url: "https://pid.geoscience.gov.au/dataset/ga/67211" },
  "ga-74137-userguide": { name: "Userguide_LowerMacquarie_GIS.pdf", sha256: "9b33f8995a6f31dde1c029ae714e941ef8aaad6d57042b27c7cfde1bdfbe0883", url: "https://d28rz98at9flks.cloudfront.net/74137/Userguide_LowerMacquarie_GIS.pdf" },
  "ga-74137-inversion": { name: "LMR_GA_AEMInversionReport.pdf", sha256: "035e258840ed3633d389eb70d42ef21899851c11a8308310db51df69bf34e17b", url: "https://d28rz98at9flks.cloudfront.net/74137/reports.zip", member: "reports/LMR_GA_AEMInversionReport.pdf" },
  "ga-ecat-74137": { name: "ecat-74137-record.pdf", sha256: "b9fe3414eca16f6524636fbd64f487e4632d591184493ac7106d4b23e2a4dd2d", url: "https://pid.geoscience.gov.au/dataset/ga/74137" },
  // Capel and Faust basins and the Lord Howe Rise.
  "ga-69470": { name: "Rec2010_003.pdf", sha256: "e9e79cd3596bb2d4bbd754e44ec771f6d4f6dca24139d602985a81237ba0e377", url: "https://d28rz98at9flks.cloudfront.net/69470/Rec2010_003.pdf", maxBytes: 128_000_000 },
  "ga-ecat-69470": { name: "ecat-69470-record.pdf", sha256: "c060f9c81b67b0cdea230072305383317dd63696375b65c83933fd091f6c3ead", url: "https://pid.geoscience.gov.au/dataset/ga/69470" },
  "ga-69190": { name: "Rec2010_006.pdf", sha256: "277c043e794d77d0b90e2e7e67641d00a6ec209d41e74b069c45ac6e24bb1c78", url: "https://d28rz98at9flks.cloudfront.net/69190/Rec2010_006.pdf", maxBytes: 128_000_000 },
  "ga-ecat-69190": { name: "ecat-69190-record.pdf", sha256: "93c6d46283cff638852e0c411b030e67a4440630c3e80b2d8c7fa0f60bcdfadb", url: "https://pid.geoscience.gov.au/dataset/ga/69190" },
  "ga-70711": { name: "Rec2010_034.pdf", sha256: "507773cdb37d390c5e38bd78fa8a3629d47d5c06c09a102381b1260c61681e70", url: "https://d28rz98at9flks.cloudfront.net/70711/Rec2010_034.pdf" },
  "ga-ecat-70711": { name: "ecat-70711-record.pdf", sha256: "713a0b9df094ef85714d129a9c74950300228bff428df20ca95865aa122d74e0", url: "https://pid.geoscience.gov.au/dataset/ga/70711" },
  "ga-65704": { name: "65704.pdf", sha256: "b4ce482ce10a950e66f7eb4986407e23701e2d2cbd1b4d8cf68eba01d8cdbf57", url: "https://d28rz98at9flks.cloudfront.net/65704/65704.pdf" },
  "ga-ecat-65704": { name: "ecat-65704-record.pdf", sha256: "44fbfb8c4aa4204a9c7eed6fe84d8eb3cefba76103c5df31ed4421bd2ebb48b6", url: "https://pid.geoscience.gov.au/dataset/ga/65704" },
  "ga-ecat-65395": { name: "ecat-65395-record.pdf", sha256: "2bbeead846494bea118e59a5845946a27071bc904d73ca74b8d74edf5a9902ab", url: "https://pid.geoscience.gov.au/dataset/ga/65395" },
  "ga-ecat-65231": { name: "ecat-65231-record.pdf", sha256: "aac885adf6cf58b5d7b48871903a920093becca48b54502dd2a2bab71df5d4bf", url: "https://pid.geoscience.gov.au/dataset/ga/65231" },
  "ga-ecat-140140": { name: "ecat-140140-record.pdf", sha256: "b8d7edbe04e2cb6515bfae983ee0b00a259b066543e19a8917377d05b1bf9fd5", url: "https://pid.geoscience.gov.au/dataset/ga/140140" },
  "ga-ecat-140141": { name: "ecat-140141-record.pdf", sha256: "c6f5af17f667c8dcb019fe94a7b520971d28725179263df2a142f2905dbe7ef9", url: "https://pid.geoscience.gov.au/dataset/ga/140141" },
  "ga-ecat-75582": { name: "ecat-75582-record.pdf", sha256: "6a6bd664ab192cf032949385f6f007a853dc538107226637b56a4abc1ec35b5f", url: "https://pid.geoscience.gov.au/dataset/ga/75582" },
  "ga-112283-metadata": { name: "GA-0354_LHR_Z57_ALL_50m.pdf", sha256: "6290d07288208c5ba922ae2817ad66ce4527c89f74c64dab76936de6c9e36d4b", url: "https://d28rz98at9flks.cloudfront.net/112283/112283_Metadata.zip", member: "05_Metadata/GA-0354_LHR_Z57_ALL_50m.pdf" },
  "ga-ecat-112283": { name: "ecat-112283-record.pdf", sha256: "2ec3e44cb63026276bf0518eb70d810333da419b51e7852c13f3de4f894792f4", url: "https://pid.geoscience.gov.au/dataset/ga/112283" },
  "ga-ecat-123889": { name: "ecat-123889-record.pdf", sha256: "d5abf89a9ae71067e3fa0313367e406bba1f6078aff2520a317ce96c2571230a", url: "https://pid.geoscience.gov.au/dataset/ga/123889" },
  "ga-116461": { name: "116461_00_0.pdf", sha256: "f139d796e50bc024bc123666ac3b1d3197b87943a22ecc0a6199407a09f334a0", url: "https://corpdata.s3.ap-southeast-2.amazonaws.com/116461/116461_00_0.pdf" },
  "ga-ecat-116461": { name: "ecat-116461-record.pdf", sha256: "3e47fda3500aefc7a95bca630ce3705c77c7a52b6ce7a29ccebcef49485eec62", url: "https://pid.geoscience.gov.au/dataset/ga/116461" },
  "ga-ecat-114642": { name: "ecat-114642-record.pdf", sha256: "f670d94e7fb8bc0a62e34318986488bb7557c12c1aede6b60a954de92c895f13", url: "https://pid.geoscience.gov.au/dataset/ga/114642" },
  // Wave 3 datum references (owner request to deploy, 5 November 2026), hashed that day. LINZ publishes its own content under
  // CC BY 4.0 (https://www.linz.govt.nz/copyright); the GDA2020 Technical Manual states CC BY 4.0 in its front matter. ANZLIC's
  // edge refuses programmatic clients, so the manual is landed through the owner upload route against this pin (ownerUpload).
  "linz-s25000": { name: "LINZS25000-NZGD2000-standard.pdf", sha256: "8cb818725387525457b511110a7ce7ad0145784941c6eb339a74488421d724fe", url: "https://www.linz.govt.nz/sites/default/files/25000-LINZS25000%2520Standard%2520for%2520New%2520Zealand%2520Geodetic%2520Datum%25202000%2520_4.pdf" },
  "linz-s25002": { name: "LINZS25002-NZGD2000-projections-v2.pdf", sha256: "0f5f770ee9b8858b679c6fb96999d70ba46cc8a35d3ef8182296c4f691de3856", url: "https://www.linz.govt.nz/sites/default/files/25002-LINZS25002%2520Standard%2520for%2520New%2520Zealand%2520Geodetic%2520Datum%25202000%2520Projections-%2520version%25202_4.pdf" },
  "linz-s25009": { name: "LINZS25009-NZVD2016-standard.pdf", sha256: "dec341be9d0f79b4192c8be5749cc472b31613c2e3f661f9fb9d0351fcb0c4df", url: "https://www.linz.govt.nz/sites/default/files/Standard%2520for%2520New%2520Zealand%2520Vertical%2520Datum%2520-%2520LINZS25009.pdf" },
  "linz-g25700": { name: "LINZG25700-NZGD2000-fact-sheet.pdf", sha256: "fadc27f7a5690dcabd9fb8db542902494510d0cb604b6db7ae6f61c593ebf7e1", url: "https://www.linz.govt.nz/sites/default/files/25700-LINZG5700%2520Fact%2520sheet%2520-%2520New%2520Zealand%2520Geodetic%2520Datum%25202000.pdf" },
  "linz-g25702": { name: "LINZG25702-NZGD2000-projections-fact-sheet.pdf", sha256: "141b7d914d9036d6eb2d5740fa26fcc2a4ae14616dcc7d83f2017310243175ed", url: "https://www.linz.govt.nz/sites/default/files/25702-LINZG25702%2520Fact%2520sheet%2520-%2520New%2520Zealand%2520Geodetic%2520Datum%25202000%2520Projections_4.pdf" },
  "linz-g25703": { name: "LINZG25703-datum-projection-transformations.pdf", sha256: "6759ea14c5a35c0473672d2832d436f0736ea8448f29be4fba535b3557ef186b", url: "https://www.linz.govt.nz/sites/default/files/25703-Datum%2520and%2520Projection%2520Transformations%2520-%2520LINZG25703%2520_0_0.pdf" },
  "linz-itrf-nzgd2000": { name: "ITRF-to-NZGD2000-2026.pdf", sha256: "7c0a3daffc86ddd451c126089e2957c3b23292d29c825ee3d3f6d117bd9109f0", url: "https://www.linz.govt.nz/sites/default/files/2026-06/ITRF%20to%20NZGD2000%20-%202026.pdf" },
  "icsm-gda2020-manual": { name: "GDA2020-Technical-Manual-V1.8.pdf", sha256: "c9326e750354c61c87fd7ec685332977b2bac9a4841eaa76abd1ed5209e03518", url: "https://www.anzlic.gov.au/sites/default/files/files/GDA2020%20Technical%20Manual%20V1.8_published.pdf", ownerUpload: true },
  // New Zealand sources the owner approved on 5 November 2026 (OWNER_APPROVED_SOURCES), hashed that day.
  "nzpam-basins-part-one": { name: "nz-petroleum-basins-part-one.pdf", sha256: "8f7e8d6c03bc4e336c3fcd267ecbdd280173d466d87e204cdd62d6fd03b0c0e5", url: "https://www.nzpam.govt.nz/assets/Uploads/doing-business/nz-petroleum-basins-part-one.pdf" },
  "nzpam-basins-part-two": { name: "nz-petroleum-basins-part-two.pdf", sha256: "63510f93b5c7424935f3499c8b1987cfab39030fd75ebce02289856f8d98edb6", url: "https://www.nzpam.govt.nz/assets/Uploads/doing-business/nz-petroleum-basins-part-two.pdf" },
  "linz-hannah-2001": { name: "assess-nzheight-systems.pdf", sha256: "9fa3265d949f1be0ea4e552848e3bb6548b1a5476d217c8a94f4964f44970a32", url: "https://www.linz.govt.nz/sites/default/files/cust/assess-nzheight-systems.pdf" },
} as const;
export type SliceSourceId = keyof typeof SOURCE_ARTIFACTS;
export const isArchiveArtifact = (id: SliceSourceId) => SOURCE_ARTIFACTS[id].name.endsWith(".zip");
export interface SourceArtifact { name: string; sha256: string; url: string; member?: string; maxBytes?: number; ownerUpload?: boolean }
export const sourceArtifact = (id: SliceSourceId): SourceArtifact => SOURCE_ARTIFACTS[id];
// The byte bound for one registered file: 60 MB unless the registration raises it, never beyond the ceiling.
export function sourceBytesFor(id: string): number {
  const own = Object.hasOwn(SOURCE_ARTIFACTS, id) ? sourceArtifact(id as SliceSourceId).maxBytes : undefined;
  return Math.min(PIPELINE_LIMITS.maxSourceBytes, own ?? PIPELINE_LIMITS.sourceBytes);
}
// Titles and attributions of the Wave 1 national sources. Every one is Geoscience Australia's under CC BY 4.0.
const pid = (ecat: string) => `https://pid.geoscience.gov.au/dataset/ga/${ecat}`;
const record = (id: SliceSourceId, ecat: string, title: string): readonly [SliceSourceId, string, string] =>
  [id, `Geoscience Australia catalogue record: ${title} (eCat ${ecat})`, `Geoscience Australia, eCat catalogue record ${ecat}, ${title}, ${pid(ecat)}.`];
export const NATIONAL_SOURCES: readonly (readonly [SliceSourceId, string, string])[] = [
  ["ga-144233", "2019 Australian National Gravity Grids explanatory notes (GA Record 2020/22)", `Geoscience Australia, 2019 Australian National Gravity Grids Explanatory Notes, Record 2020/22, ${pid("144233")}.`],
  ["ga-133023-points", "Explanatory notes: gravity ground point located data summary (2019 national gravity grids, eCat 133023)", `Geoscience Australia, Explanatory notes: gravity ground point located data summary, 2020, ${pid("133023")}.`],
  ["ga-145744", "AusAEM Eastern Resources Corridor 2021 survey: data release summary (eCat 145744)", `Ley-Cooper, A.Y., Exploring for the Future AusAEM Eastern Resources Corridor data release summary, Geoscience Australia, ${pid("145744")}.`],
  ["ga-147688", "AusAEM Western Resources Corridor survey blocks: data release summary (eCat 147688)", `Ley-Cooper, A.Y. and Symington, N., AusAEM Western Resources Corridor data release summary, Geoscience Australia, ${pid("147688")}.`],
  ["ga-146380", "High resolution conductivity mapping using regional AEM survey and machine learning (Wilford et al., 2022)", `Wilford, J., Ley-Cooper, Y., Basak, S. and Czarnota, K., 2022, High resolution conductivity mapping using regional AEM survey and machine learning, Exploring for the Future: Extended Abstracts, Geoscience Australia, ${pid("146380")}.`],
  ["ga-81486", "The Australian National Gravity Database (Murray, 1997)", `Murray, A.S., 1997, The Australian National Gravity Database, AGSO Journal of Australian Geology and Geophysics 17(1), 145-155, ${pid("81486")}.`],
  record("ga-ecat-133023", "133023", "2019 Australian National Gravity Grids: Free Air Anomaly, Complete Bouguer Anomaly, De-trended Global Isostatic Residual, 400 m cell size (includes Point Located Data)"),
  record("ga-ecat-145744", "145744", "Exploring for the Future AusAEM Eastern Resources Corridor: 2021 Airborne Electromagnetic Survey TEMPEST® airborne electromagnetic data and GALEI inversion conductivity estimates"),
  record("ga-ecat-147688", "147688", "AusAEM, Western Resources Corridor, Airborne Electromagnetic Survey Blocks. TEMPEST airborne electromagnetic data and GALEI conductivity estimates"),
  record("ga-ecat-148588", "148588", "National surface and near-surface conductivity grids"),
  record("ga-ecat-67240", "67240", "Gravity Anomaly Grid of the Australian Region - 2009"),
  record("ga-ecat-65388", "65388", "AAGD07: A new absolute gravity datum for Australian gravity and new standards for the Australian National Gravity Database"),
  record("ga-ecat-126310", "126310", "Geoscience Australia Borehole Database (BOREHOLE)"),
  record("ga-ecat-100520", "100520", "SUPERSEDED - Australian Onshore and Offshore Borehole Data"),
];
// Titles and attributions of the Wave 2 national sources, also Geoscience Australia's under CC BY 4.0. A report written by a
// contractor (Fugro, Intrepid Geophysics) names its author and the Geoscience Australia record that publishes it.
export const NATIONAL_SOURCES_WAVE2: readonly (readonly [SliceSourceId, string, string])[] = [
  // Honeysuckle Creek TEMPEST AEM survey, Victoria, 2001.
  ["ga-74123-userguide", "Honeysuckle Creek TEMPEST AEM survey: GIS user guide (eCat 74123)", `Geoscience Australia, Honeysuckle Creek final GA-LEI inversion of TEMPEST AEM survey, VIC, 2008: GIS user guide, in Layered earth inversion and related airborne geophysical datasets derived from the Honeysuckle Creek TEMPEST AEM Survey, Victoria, 2001, ${pid("74123")}.`],
  ["ga-74123-inversion", "Inversion of TEMPEST AEM survey data, Honeysuckle Creek, Victoria (Brodie and Fisher; eCat 74123)", `Brodie, R.C. and Fisher, A., Inversion of TEMPEST AEM survey data, Honeysuckle Creek, Victoria, Geoscience Australia, reports/HSK_Inversion_Report.pdf in eCat 74123, ${pid("74123")}.`],
  ["ga-74123-fugro", "Honeysuckle Creek TEMPEST survey: acquisition and processing report (Fugro job 903; eCat 74123)", `Lawrence, M., Lane, R. and Baron-Hay, S., Honeysuckle Creek, Victoria, TEMPEST geophysical survey for the Bureau of Rural Sciences: acquisition and processing report, published by Geoscience Australia as reports/HSK_Fugro_AEM_Report_Job_903.pdf in eCat 74123, ${pid("74123")}.`],
  ["ga-74123-metadata", "Geophysical survey data and metadata, Honeysuckle Creek, Victoria (Fisher and Brodie; eCat 74123)", `Fisher, A. and Brodie, R.C., Geophysical survey data and metadata, Honeysuckle Creek, Victoria, Geoscience Australia, reports/HSK_Geophysics_Metadata.pdf in eCat 74123, ${pid("74123")}.`],
  record("ga-ecat-74123", "74123", "Layered earth inversion and related airborne geophysical datasets derived from the Honeysuckle Creek TEMPEST AEM Survey, Victoria, 2001"),
  record("ga-ecat-65384", "65384", "Honeysuckle Creek TEMPEST AEM Survey, Victoria, 2001 Final Located Data (P903)"),
  record("ga-ecat-84308", "84308", "SMMSP - AEM - Honeysuckle Creek, Vic, 2001"),
  // AusAEM inversion products.
  ["ga-132709", "AusAEM Year 1 NT/QLD airborne electromagnetic survey: GA layered earth inversion products (Ley-Cooper and Brodie; eCat 132709)", `Ley-Cooper, A.Y. and Brodie, R.C., AusAEM Year 1 NT/QLD Airborne Electromagnetic Survey: GA Layered Earth Inversion Products, Geoscience Australia, ${pid("132709")}.`],
  record("ga-ecat-132709", "132709", "AusAEM Year 1 NT/QLD Airborne Electromagnetic Survey; GA Layered Earth Inversion Products"),
  ["ga-149375", "Probabilistic AEM inversion of 20-km AusAEM data, Phase 1 (eCat 149375)", `Geoscience Australia, Probabilistic airborne electromagnetic (AEM) inversion of 20-km AusAEM data, Phase 1, ${pid("149375")}.`],
  record("ga-ecat-149375", "149375", "Probabilistic airborne electromagnetic inversion of 20 km AusAEM data, Phase 1"),
  // Isostatic residual gravity.
  ["ga-145984-report", "Isostatic residual gravity anomaly of Australia (Intrepid Geophysics report, 2021; eCat 145984)", `Intrepid Geophysics, Isostatic Residual Gravity Anomaly of Australia, report prepared for Geoscience Australia, 4 November 2021, published by Geoscience Australia as IsostaticResidualAustraliaReport_2111.pdf in eCat 145984, ${pid("145984")}.`],
  record("ga-ecat-145984", "145984", "2019 Isostatic residual grids of Australia using elevation derived and seismic Moho grids"),
  record("ga-ecat-144778", "144778", "National Gravity Compilation 2019 DGIR grid"),
  record("ga-ecat-144775", "144775", "National Gravity Compilation 2019 includes airborne DGIR grid"),
  record("ga-ecat-144783", "144783", "National Gravity Compilation 2019 includes airborne (CSCBA)"),
  ["ga-144414", "2019 B-Series de-trended global isostatic residual gravity map of Australia (eCat 144414)", `Geoscience Australia, 2019 B-Series De-trended Global Isostatic Residual Gravity Map of Australia, ${pid("144414")}.`],
  record("ga-ecat-144414", "144414", "2019 B-Series De-trended Global Isostatic Residual Gravity Map of Australia"),
  // River Murray Corridor RESOLVE and Lower Macquarie River TEMPEST surveys.
  ["ga-67212-fugro", "River Murray Corridor AEM mapping survey: acquisition and processing report (eCat 67212)", `River Murray Corridor Airborne Electromagnetic (AEM) Mapping Survey: Acquisition and Processing Report, prepared for the Bureau of Rural Sciences, published by Geoscience Australia as 67212/RMC_fugro_final_report.pdf in eCat 67212, ${pid("67212")}.`],
  record("ga-ecat-67212", "67212", "River Murray Corridor RESOLVE AEM Survey, VIC & NSW, 2007 Final Data (P1141)"),
  ["ga-68792-methodology", "River Murray Corridor salinity mapping and interpretation project: methodology report (Professional Opinion 2009/12; eCat 68792)", `Geoscience Australia, River Murray Corridor (RMC) Salinity Mapping and Interpretation Project: Methodology Report, Professional Opinion 2009/12, reports/methodology/RMC_Methodology_Report_FINAL.pdf in eCat 68792, ${pid("68792")}.`],
  ["ga-68792-userguide", "River Murray Corridor Victorian AEM mapping project: Speewa GIS user guide (eCat 68792)", `Geoscience Australia, River Murray Corridor Victorian AEM Mapping Project, Speewa GIS User Guide, reports/Userguide_Speewa_GIS.pdf in eCat 68792, ${pid("68792")}.`],
  record("ga-ecat-68792", "68792", "Speewa GIS; River Murray Corridor Salinity Mapping and Interpretation Project"),
  ["ga-67211-report", "Lower Macquarie River AEM mapping survey: acquisition and processing report (eCat 67211)", `Lower Macquarie River Airborne Electromagnetic (AEM) Mapping Survey: Acquisition and Processing Report, prepared for the Bureau of Rural Sciences, published by Geoscience Australia as 67211/Lower_Macquarie_River_Report.pdf in eCat 67211, ${pid("67211")}.`],
  record("ga-ecat-67211", "67211", "Lower Macquarie River TEMPEST AEM Survey, NSW, 2007 Final Data (P1140)"),
  ["ga-74137-userguide", "Lower Macquarie River TEMPEST AEM survey: GIS user guide (eCat 74137)", `Geoscience Australia, Layered earth inversion of the Lower Macquarie River TEMPEST AEM Survey, NSW, 2007: GIS user guide, ${pid("74137")}.`],
  ["ga-74137-inversion", "Inversion of TEMPEST AEM survey data, Lower Macquarie River, New South Wales (Brodie and Fisher; eCat 74137)", `Brodie, R.C. and Fisher, A., Inversion of TEMPEST AEM survey data, Lower Macquarie River, New South Wales, Geoscience Australia, reports/LMR_GA_AEMInversionReport.pdf in eCat 74137, ${pid("74137")}.`],
  record("ga-ecat-74137", "74137", "Layered earth inversion and related airborne geophysical datasets derived from the Lower Macquarie River TEMPEST AEM Survey, New South Wales, 2007."),
  // Capel and Faust basins and the Lord Howe Rise.
  ["ga-69470", "Seismic velocity models of the sediments and upper crust of the Capel and Faust basins, Lord Howe Rise (GA Record 2010/03)", `Petkovic, P., 2010, Seismic velocity models of the sediments and upper crust of the Capel and Faust Basins, Lord Howe Rise, Geoscience Australia Record 2010/03, ${pid("69470")}.`],
  record("ga-ecat-69470", "69470", "Seismic Velocity Models of the Sediments and Upper Crust of the Capel and Faust Basins, Lord Howe Rise"),
  ["ga-69190", "Interpretation of seismic data, Capel and Faust basins (GA Record 2010/06)", `Colwell, J.B., Hashimoto, T., Rollet, N., Higgins, K., Bernardel, G. and McGiveron, S., 2010, Interpretation of seismic data, Capel and Faust Basins, Australia's remote offshore eastern frontier, Geoscience Australia Record 2010/06, ${pid("69190")}.`],
  record("ga-ecat-69190", "69190", "Interpretation of Seismic Data, Capel and Faust Basins, Australia's Remote Offshore Eastern Frontier"),
  ["ga-70711", "Potential-field data covering the Capel and Faust basins (GA Record 2010/34)", `Hackney, R., 2010, Potential-field data covering the Capel and Faust Basins, Australia's remote offshore eastern frontier, Geoscience Australia Record 2010/34, ${pid("70711")}.`],
  record("ga-ecat-70711", "70711", "Potential-field Data Covering the Capel and Faust Basins, Australia's Remote Offshore Eastern Frontier"),
  ["ga-65704", "Capel and Faust basins: new information from the offshore frontier between Australia, New Zealand and New Caledonia (2008 New Zealand Petroleum Conference)", `Hashimoto, T., Rollet, N., Earl, K., Bernardel, G. and Colwell, J., 2008, Capel and Faust Basins: new information from the offshore frontier between Australia, New Zealand and New Caledonia, 2008 New Zealand Petroleum Conference, Geoscience Australia, ${pid("65704")}.`],
  record("ga-ecat-65704", "65704", "Capel and Faust Basins - New Information from the Offshore Frontier Between Australia, New Zealand and New Caledonia"),
  record("ga-ecat-65395", "65395", "Preliminary Results from Marine Seismic Survey GA302 over Capel and Faust Basins"),
  record("ga-ecat-65231", "65231", "Preliminary Results from marine seismic survey GA302 over Capel and Faust Basins"),
  record("ga-ecat-140140", "140140", "Capel and Faust Basins Marine Gravity Data"),
  record("ga-ecat-140141", "140141", "Capel and Faust Basins Marine Magnetic Data"),
  record("ga-ecat-75582", "75582", "Faust Capel Basins Survey (GA-2436/ TAN0713) - Bathymetry grids"),
  ["ga-112283-metadata", "Lord Howe Rise survey 2016 (GA-0354/KR1605): bathymetry grid sheet, zone 57, 50 m (eCat 112283)", `Geoscience Australia, Lord Howe Rise Marine Seismic Survey 2016 (GA-0354/KR1605) bathymetry grids, metadata sheet 05_Metadata/GA-0354_LHR_Z57_ALL_50m.pdf, ${pid("112283")}.`],
  record("ga-ecat-112283", "112283", "Lord Howe Rise Marine Seismic Survey 2016 (GA-0354/ KR1605) Bathymetry grids"),
  record("ga-ecat-123889", "123889", "Lord Howe Rise Marine Survey 2017 (GA-0363/ KR17-15C) Bathymetry grids"),
  ["ga-116461", "Towards IODP deep riser drilling in northern Zealandia: outcomes of pre-drilling site surveys on the Lord Howe Rise continental ribbon (eCat 116461)", `Geoscience Australia, Towards IODP deep riser stratigraphic drilling in northern Zealandia: outcomes of pre-drilling site surveys on the Lord Howe Rise continental ribbon, ${pid("116461")}.`],
  record("ga-ecat-116461", "116461", "Towards IODP deep riser stratigraphic drilling in northern Zealandia: outcomes of pre-drilling site surveys on the Lord Howe Rise continental ribbon"),
  record("ga-ecat-114642", "114642", "Crustal structure across the Lord Howe Rise, northern Zealandia, and rifting of the eastern Gondwana margin"),
];
// Wave 3: datum references from LINZ and ICSM, as [id, title, attribution, publisher, licence basis]. They describe NZGD2000, NZTM2000,
// NZVD2016, the ITRF to NZGD2000 transformation and the Australian datums, including the AGD to GDA94 offset.
export const NATIONAL_SOURCES_WAVE3: readonly (readonly [SliceSourceId, string, string, string, string])[] = [
  ["linz-s25000", "LINZS25000 Standard for New Zealand Geodetic Datum 2000 (NZGD2000)", "Source: Toitū Te Whenua Land Information New Zealand, LINZS25000 Standard for New Zealand Geodetic Datum 2000, 2007, licensed by Toitū Te Whenua Land Information New Zealand for re-use under CC BY 4.0.", "Toitū Te Whenua Land Information New Zealand", "Owner request to deploy, 5 November 2026; LINZ's copyright page (https://www.linz.govt.nz/copyright, read that day) licenses content produced by LINZ under the Creative Commons Attribution 4.0 International licence unless otherwise specified, and this document specifies nothing else."],
  ["linz-s25002", "LINZS25002 Standard for New Zealand Geodetic Datum 2000 projections, version 2 (NZTM2000)", "Source: Toitū Te Whenua Land Information New Zealand, LINZS25002 Standard for New Zealand Geodetic Datum 2000 Projections, version 2, 2008, licensed by Toitū Te Whenua Land Information New Zealand for re-use under CC BY 4.0.", "Toitū Te Whenua Land Information New Zealand", "Owner request to deploy, 5 November 2026; LINZ's copyright page (https://www.linz.govt.nz/copyright, read that day) licenses content produced by LINZ under the Creative Commons Attribution 4.0 International licence unless otherwise specified, and this document specifies nothing else."],
  ["linz-s25009", "LINZS25009 Standard for New Zealand Vertical Datum 2016 (NZVD2016)", "Source: Toitū Te Whenua Land Information New Zealand, LINZS25009 Standard for New Zealand Vertical Datum 2016, 2016, licensed by Toitū Te Whenua Land Information New Zealand for re-use under CC BY 4.0.", "Toitū Te Whenua Land Information New Zealand", "Owner request to deploy, 5 November 2026; LINZ's copyright page (https://www.linz.govt.nz/copyright, read that day) licenses content produced by LINZ under the Creative Commons Attribution 4.0 International licence unless otherwise specified, and this document specifies nothing else."],
  ["linz-g25700", "LINZG25700 fact sheet: New Zealand Geodetic Datum 2000", "Source: Toitū Te Whenua Land Information New Zealand, LINZG25700 fact sheet, New Zealand Geodetic Datum 2000, licensed by Toitū Te Whenua Land Information New Zealand for re-use under CC BY 4.0.", "Toitū Te Whenua Land Information New Zealand", "Owner request to deploy, 5 November 2026; LINZ's copyright page (https://www.linz.govt.nz/copyright, read that day) licenses content produced by LINZ under the Creative Commons Attribution 4.0 International licence unless otherwise specified, and this document specifies nothing else."],
  ["linz-g25702", "LINZG25702 fact sheet: New Zealand Geodetic Datum 2000 projections", "Source: Toitū Te Whenua Land Information New Zealand, LINZG25702 fact sheet, New Zealand Geodetic Datum 2000 Projections, licensed by Toitū Te Whenua Land Information New Zealand for re-use under CC BY 4.0.", "Toitū Te Whenua Land Information New Zealand", "Owner request to deploy, 5 November 2026; LINZ's copyright page (https://www.linz.govt.nz/copyright, read that day) licenses content produced by LINZ under the Creative Commons Attribution 4.0 International licence unless otherwise specified, and this document specifies nothing else."],
  ["linz-g25703", "LINZG25703 fact sheet: datum and projection transformations", "Source: Toitū Te Whenua Land Information New Zealand, LINZG25703 fact sheet, Datum and Projection Transformations, version 2, 2009, licensed by Toitū Te Whenua Land Information New Zealand for re-use under CC BY 4.0.", "Toitū Te Whenua Land Information New Zealand", "Owner request to deploy, 5 November 2026; LINZ's copyright page (https://www.linz.govt.nz/copyright, read that day) licenses content produced by LINZ under the Creative Commons Attribution 4.0 International licence unless otherwise specified, and this document specifies nothing else."],
  ["linz-itrf-nzgd2000", "Transforming between ITRF and NZGD2000 (LINZ, 2026)", "Source: Toitū Te Whenua Land Information New Zealand, Transforming between ITRF and NZGD2000, 2026, licensed by Toitū Te Whenua Land Information New Zealand for re-use under CC BY 4.0.", "Toitū Te Whenua Land Information New Zealand", "Owner request to deploy, 5 November 2026; LINZ's copyright page (https://www.linz.govt.nz/copyright, read that day) licenses content produced by LINZ under the Creative Commons Attribution 4.0 International licence unless otherwise specified, and this document specifies nothing else."],
  ["icsm-gda2020-manual", "GDA2020 Technical Manual, version 1.8 (ICSM, 2024)", "Intergovernmental Committee on Surveying and Mapping, Geocentric Datum of Australia 2020 Technical Manual, version 1.8, 2024, © Commonwealth of Australia (Geoscience Australia), CC BY 4.0.", "Intergovernmental Committee on Surveying and Mapping (ICSM)", "Owner request to deploy, 5 November 2026; the manual's front matter (PDF page 4) provides it under the Creative Commons Attribution 4.0 International Licence. Landed through the owner upload route from a copy downloaded from the publisher URL that day, checked against this pin."],
];
// New Zealand sources loaded on the owner's decision of 5 November 2026, as [id, title, attribution, publisher, licence, licence basis].
export const OWNER_APPROVED_SOURCES: readonly (readonly [SliceSourceId, string, string, string, string, string])[] = [
  ["nzpam-basins-part-one", "New Zealand's Petroleum Basins, Part One (NZP&M, 2014)", "New Zealand Petroleum & Minerals, New Zealand's Petroleum Basins, Part One, 2014. ©Crown Copyright, reproduced with permission from the New Zealand Petroleum and Minerals website at www.nzpam.govt.nz.", "New Zealand Petroleum & Minerals", "Crown copyright (New Zealand), reproduced with permission", "Licence review, 5 November 2026: NZP&M's copyright page (https://www.nzpam.govt.nz/about/copyright, updated 6 September 2023) permits Crown copyright material on its website to be reproduced free of charge in any format without specific permission, provided it is reproduced accurately, not in a misleading context and with the acknowledgement in the attribution. Material identified as third-party copyright is not covered: the basin map credited to GNS Science (Part One page 16, Part Two page 61) is reproduced only within the page images."],
  ["nzpam-basins-part-two", "New Zealand's Petroleum Basins, Part Two (NZP&M, 2014)", "New Zealand Petroleum & Minerals, New Zealand's Petroleum Basins, Part Two, 2014. ©Crown Copyright, reproduced with permission from the New Zealand Petroleum and Minerals website at www.nzpam.govt.nz.", "New Zealand Petroleum & Minerals", "Crown copyright (New Zealand), reproduced with permission", "Licence review, 5 November 2026: NZP&M's copyright page (https://www.nzpam.govt.nz/about/copyright, updated 6 September 2023) permits Crown copyright material on its website to be reproduced free of charge in any format without specific permission, provided it is reproduced accurately, not in a misleading context and with the acknowledgement in the attribution. Material identified as third-party copyright is not covered: the basin map credited to GNS Science (Part One page 16, Part Two page 61) is reproduced only within the page images."],
  ["linz-hannah-2001", "An assessment of New Zealand's height systems and options for a future height datum (Hannah, 2001)", "Hannah, J., An Assessment of New Zealand's Height Systems and Options for a Future Height Datum, report for the Surveyor-General, January 2001, published by Toitū Te Whenua Land Information New Zealand, CC BY 4.0.", "Toitū Te Whenua Land Information New Zealand", "CC BY 4.0", "Licence review, 5 November 2026: LINZ publishes this report, prepared for the Surveyor-General, with no other terms, and the owner treats it as covered by LINZ's statement that content produced by LINZ is licensed under CC BY 4.0 unless otherwise specified (https://www.linz.govt.nz/copyright)."],
];
export interface PipelineJob extends Row {
  partitionKey: "job"; rowKey: string; sourceId: SliceSourceId; sha256: string; blob: string; owner: string; status: string;
  extractionVersion?: string; recipeJson?: string; leaseId?: string; leaseUntil?: number; attempts: number; createdAt: string;
  detail?: string; manifestVersion?: number; publicationMode?: "approval" | "republish"; expectedManifestVersion?: number;
}
export function sourceBlobName(id: SliceSourceId, sha256: string): string {
  if (!Object.hasOwn(SOURCE_ARTIFACTS, id) || !/^[a-f0-9]{64}$/.test(sha256)) throw new PipelineError(400, "Invalid source landing identity.");
  return `sources/${id}/${sha256}/${SOURCE_ARTIFACTS[id].name}`;
}
export function sourceFromRow(row: SourceRegistryRow): SourceRegistry {
  if (row.partitionKey !== "source" || row.rowKey !== row.sourceId) throw new Error("Invalid registry identity.");
  const wellLocation = JSON.parse(row.wellLocationJson), v1DocIds = JSON.parse(row.v1DocIdsJson);
  if (!Array.isArray(v1DocIds) || !v1DocIds.every((x) => typeof x === "string")) throw new Error("Invalid registry mappings.");
  return { sourceId: row.sourceId, publisher: row.publisher, title: row.title, url: row.url, licence: row.licence, attribution: row.attribution,
    expectedSha256: row.expectedSha256, publishAllowed: row.publishAllowed === true, licenceBasis: row.licenceBasis, freshness: row.freshness,
    wellLocation, v1DocIds };
}
// Live sources must be CC BY 4.0 or carry reuse terms the owner has approved: a publisher's explicit permission to reproduce,
// recorded with the decision in the source's licence basis. Freely readable is not enough, and "all rights reserved" never is.
export const OWNER_APPROVED_TERMS: Readonly<Record<string, string>> = {
  "Crown copyright (New Zealand), reproduced with permission": "https://www.nzpam.govt.nz/about/copyright",
};
export const reuseAllowed = (licence: string) => licence === "CC BY 4.0" || Object.hasOwn(OWNER_APPROVED_TERMS, licence);
export async function allowedSource(store: PipelineStore, id: string, signal?: AbortSignal) {
  if (!Object.hasOwn(SOURCE_ARTIFACTS, id) || LICENCE.isWithheldSource(id)) throw new PipelineError(403, "This source is not enabled for the live lane.");
  const row = await store.get<SourceRegistryRow>(LIVE_TABLES.sourceRegistry, "source", id, signal);
  if (!row) throw new PipelineError(503, "Source registry is not initialized.");
  const source = validateRegistrySource(sourceFromRow(row));
  if (!source.publishAllowed || LICENCE.referencesWithheld(source) || !reuseAllowed(source.licence) || !source.licenceBasis?.trim()
    || !/^[a-f0-9]{64}$/.test(source.expectedSha256) || !source.publisher?.trim() || !source.attribution?.trim()) throw new PipelineError(403, "Source publication permission is absent or invalid.");
  if (id === "peps-sa-marabooka-1" && (!source.wellLocation || source.wellLocation.datum !== "GDA94"
    || !Number.isFinite(source.wellLocation.lon) || !Number.isFinite(source.wellLocation.lat))) throw new PipelineError(409, "Marabooka needs its registered GDA94 location.");
  return { source, etag: row.etag };
}
export async function seedRegistry(store: PipelineStore, signal?: AbortSignal) {
  const cleared: SourceRegistry[] = [
    { ...SOURCE_REGISTRY_DEFAULTS, sourceId: "ga-147461", publisher: "Geoscience Australia", title: "Cooper Basin regional geology (GA 147461)",
      url: SOURCE_ARTIFACTS["ga-147461"].url, licence: "CC BY 4.0", attribution: "Geoscience Australia, Cooper Basin regional geology, 2023, https://doi.org/10.26186/147461.",
      expectedSha256: SOURCE_ARTIFACTS["ga-147461"].sha256, publishAllowed: true, licenceBasis: "Licence review cleared CC BY 4.0; licence verified 30 October 2026.", wellLocation: null, v1DocIds: [...PHASE1A_V1_DOC_IDS["ga-147461"]] },
    { ...SOURCE_REGISTRY_DEFAULTS, sourceId: "peps-sa-marabooka-1", publisher: "Department for Energy and Mining, South Australia (PEPS SA)", title: "Marabooka 1 well completion report",
      url: "bundle-copy", licence: "CC BY 4.0", attribution: "Department for Energy and Mining, South Australia (PEPS SA).",
      expectedSha256: SOURCE_ARTIFACTS["peps-sa-marabooka-1"].sha256, publishAllowed: true, licenceBasis: "Licence review cleared CC BY 4.0 for the checksum-verified bundle copy; publisher freshness NOT VERIFIED.",
      wellLocation: { lon: 140.6102, lat: -28.176, datum: "GDA94" }, v1DocIds: [...PHASE1A_V1_DOC_IDS["peps-sa-marabooka-1"]] },
    ...([["ga-147459", "North Bowen"], ["ga-147460", "Galilee"], ["ga-147462", "Adavale"]] as const).map(([id, basin]): SourceRegistry => ({
      ...SOURCE_REGISTRY_DEFAULTS, sourceId: id, publisher: "Geoscience Australia", title: `${basin} Basin regional geology (GA ${id.slice(3)})`,
      url: SOURCE_ARTIFACTS[id].url, licence: "CC BY 4.0", attribution: `Geoscience Australia, ${basin} Basin regional geology, 2023, https://doi.org/10.26186/${id.slice(3)}.`,
      expectedSha256: SOURCE_ARTIFACTS[id].sha256, publishAllowed: true,
      licenceBasis: "Licence review cleared CC BY 4.0 on 4 November 2026 (data/sources/manifest.csv records CC BY 4.0); GA's catalogue page was not re-read.",
      wellLocation: null, v1DocIds: [...PHASE1A_V1_DOC_IDS[id]] })),
    { ...SOURCE_REGISTRY_DEFAULTS, sourceId: "peps-sa-habanero-1", publisher: "Department for Energy and Mining, South Australia (PEPS SA)", title: "Habanero 1 well files",
      url: "bundle-copy", licence: "CC BY 4.0", attribution: "Department for Energy and Mining, South Australia (PEPS SA).",
      expectedSha256: SOURCE_ARTIFACTS["peps-sa-habanero-1"].sha256, publishAllowed: true,
      licenceBasis: "Licence review cleared CC BY 4.0 on 4 November 2026 for an archive of the six checksum-verified bundle PDFs (pipeline/bundle_habanero.py); publisher freshness NOT VERIFIED.",
      wellLocation: null, v1DocIds: [] },
    ...NATIONAL_SOURCES.map(([id, title, attribution]): SourceRegistry => ({
      ...SOURCE_REGISTRY_DEFAULTS, sourceId: id, publisher: "Geoscience Australia", title, url: SOURCE_ARTIFACTS[id].url, licence: "CC BY 4.0", attribution,
      expectedSha256: SOURCE_ARTIFACTS[id].sha256, publishAllowed: true,
      licenceBasis: "Owner request to load, 4 November 2026; the eCat record states Creative Commons Attribution 4.0 International Licence (read through the eCat API on 4 November 2026).",
      wellLocation: null, v1DocIds: [] })),
    ...NATIONAL_SOURCES_WAVE2.map(([id, title, attribution]): SourceRegistry => ({
      ...SOURCE_REGISTRY_DEFAULTS, sourceId: id, publisher: "Geoscience Australia", title, url: SOURCE_ARTIFACTS[id].url, licence: "CC BY 4.0", attribution,
      expectedSha256: SOURCE_ARTIFACTS[id].sha256, publishAllowed: true,
      licenceBasis: "Owner request to prepare for loading, 5 November 2026; the eCat record states Creative Commons Attribution 4.0 International Licence (read through the eCat API on 5 November 2026)."
        + (sourceArtifact(id).member ? " The file is one PDF read out of the archive that record publishes." : ""),
      wellLocation: null, v1DocIds: [] })),
    ...NATIONAL_SOURCES_WAVE3.map(([id, title, attribution, publisher, licenceBasis]): SourceRegistry => ({
      ...SOURCE_REGISTRY_DEFAULTS, sourceId: id, publisher, title, url: SOURCE_ARTIFACTS[id].url, licence: "CC BY 4.0", attribution,
      expectedSha256: SOURCE_ARTIFACTS[id].sha256, publishAllowed: true, licenceBasis, wellLocation: null, v1DocIds: [] })),
    ...OWNER_APPROVED_SOURCES.map(([id, title, attribution, publisher, licence, licenceBasis]): SourceRegistry => ({
      ...SOURCE_REGISTRY_DEFAULTS, sourceId: id, publisher, title, url: SOURCE_ARTIFACTS[id].url, licence, attribution,
      expectedSha256: SOURCE_ARTIFACTS[id].sha256, publishAllowed: true, licenceBasis, wellLocation: null, v1DocIds: [] })),
  ];
  const rows: SourceRegistry[] = [...cleared, ...WITHHELD_SOURCES.map((s): SourceRegistry => ({ ...SOURCE_REGISTRY_DEFAULTS,
    sourceId: s.id, publisher: s.reference, title: s.title, url: "bundle-copy", licence: "Reuse terms not confirmed", attribution: s.reference,
    expectedSha256: "", licenceBasis: s.reason, wellLocation: null, v1DocIds: [] }))];
  for (const { wellLocation, v1DocIds, ...source } of rows) {
    try { await store.put(LIVE_TABLES.sourceRegistry, { ...source, partitionKey: "source", rowKey: source.sourceId, wellLocationJson: JSON.stringify(wellLocation), v1DocIdsJson: JSON.stringify(v1DocIds) }, undefined, signal); }
    catch (e) { if (statusOf(e) !== 409) throw e; } // Never overwrite an owner's registry decision.
  }
}
export async function landArtifact(store: PipelineStore, id: string, bytes: Buffer, owner: string, signal?: AbortSignal) {
  const { source } = await allowedSource(store, id, signal);
  const bound = sourceBytesFor(id);
  if (!owner || bytes.length < 1 || bytes.length > bound) throw new PipelineError(413, "A nonempty source within its registered size bound is required.");
  const sha256 = sha256Of(bytes);
  if (sha256 !== source.expectedSha256) {
    try { await store.put(PIPELINE_TABLES.versions, { partitionKey: id, rowKey: sha256, sourceId: id, sha256, expectedSha256: source.expectedSha256,
      publishAllowed: false, status: "unapproved-version", bytes: bytes.length, seenAt: new Date().toISOString(), owner }, undefined, signal); }
    catch (e) { if (statusOf(e) !== 409) throw e; }
    throw new PipelineError(409, "Hash differs from the authorized source. A non-publishable version record was saved; nothing was queued.");
  }
  const sourceId = id as SliceSourceId, blob = sourceBlobName(sourceId, sha256);
  const isPdf = bytes.subarray(0, 5).toString() === "%PDF-", isZip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  if ((isArchiveArtifact(sourceId) && !isZip) || (!isArchiveArtifact(sourceId) && !isPdf)) throw new PipelineError(415, "The authorized source has an unexpected file type.");
  try { await store.write("quarantine", blob, bytes, { ifNoneMatch: "*" }, isPdf ? "application/pdf" : "application/zip", { sha256, sourceid: id }, signal); }
  catch (e) { if (![409, 412].includes(statusOf(e) ?? 0)) throw e;
    const prior = await store.read("quarantine", blob, bound, signal);
    if (!prior || sha256Of(prior.buffer) !== sha256) throw new PipelineError(409, "Existing quarantine bytes differ; no overwrite was attempted."); }
  const jobId = randomUUID();
  const job: PipelineJob = { partitionKey: "job", rowKey: jobId, sourceId, sha256, blob, owner, status: "queued", attempts: 0, createdAt: new Date().toISOString() };
  await store.put(PIPELINE_TABLES.jobs, job, undefined, signal);
  await queueJob(store, job, signal);
  return { jobId, sourceId, sha256, status: "queued" };
}
// The same message either way; with the live scan off it skips the scanner and goes straight to processing.
export const liveQueue = () => cfg.live.scan ? LIVE_QUEUES.scan : LIVE_QUEUES.process;
export const queueJob = (store: PipelineStore, job: PipelineJob, signal?: AbortSignal) => store.send(liveQueue(),
  Buffer.from(JSON.stringify({ jobId: job.rowKey, blob: job.blob, owner: job.owner, route: LIVE_QUEUES.process })).toString("base64"), signal);
