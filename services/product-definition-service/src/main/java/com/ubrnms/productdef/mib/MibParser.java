package com.ubrnms.productdef.mib;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.*;
import java.util.stream.Collectors;

/**
 * SMIv2 MIB file parser.
 *
 * <p>Parses a standard textual MIB file (RFC 2578 SMIv2 format) and extracts
 * every OBJECT-TYPE definition with its OID, SYNTAX, MAX-ACCESS, and INDEX structure.
 *
 * <h2>Algorithm</h2>
 * <ol>
 *   <li><b>Strip comments</b> — removes {@code --} line and inline comments.</li>
 *   <li><b>OID map build</b> — collects every {@code ::= { parent N }} assignment to
 *       resolve symbolic names to numeric OIDs, seeded with IETF well-known roots.</li>
 *   <li><b>OBJECT-TYPE extraction</b> — state-machine scan for all OBJECT-TYPE blocks.</li>
 *   <li><b>Table structure analysis</b> — identifies which objects have INDEX clauses
 *       (table entries) so that their column children inherit the correct index count.</li>
 *   <li><b>Classification</b> — marks each accessible object as SCALAR, SINGLE_INDEX,
 *       DOUBLE_INDEX, or TRIPLE_INDEX based on the inherited INDEX count.</li>
 *   <li><b>Type mapping</b> — maps MIB SYNTAX to NMS canonical data types.</li>
 * </ol>
 *
 * <h2>Root-cause fix</h2>
 * The current hand-built XML typed every field as {@code enum} and applied table
 * indexes to scalar objects, causing many SNMP GETs to return "not served".
 * This parser reads the INDEX clause directly from the MIB so the generated XML
 * always carries the correct type and index structure.
 */
@Slf4j
@Component
public class MibParser {

    // ── Well-known IETF OID roots ─────────────────────────────────────────────

    private static final Map<String, String> WELL_KNOWN;
    static {
        Map<String, String> m = new HashMap<>();
        m.put("iso",           "1");
        m.put("org",           "1.3");
        m.put("dod",           "1.3.6");
        m.put("internet",      "1.3.6.1");
        m.put("mgmt",          "1.3.6.1.2");
        m.put("mib-2",         "1.3.6.1.2.1");
        m.put("interfaces",    "1.3.6.1.2.1.2");
        m.put("ip",            "1.3.6.1.2.1.4");
        m.put("transmission",  "1.3.6.1.2.1.10");
        m.put("experimental",  "1.3.6.1.3");
        m.put("private",       "1.3.6.1.4");
        m.put("enterprises",   "1.3.6.1.4.1");
        m.put("zeroDotZero",   "0.0");
        m.put("ccitt",         "0");
        m.put("joint-iso-ccitt", "2");
        m.put("snmpV2",        "1.3.6.1.6");
        m.put("snmpModules",   "1.3.6.1.6.3");
        WELL_KNOWN = Collections.unmodifiableMap(m);
    }

    // ── Syntax → NMS dataType mapping ────────────────────────────────────────

    private static final Map<String, String> SYNTAX_TO_NMS;
    static {
        Map<String, String> m = new LinkedHashMap<>();
        // Integer types
        m.put("INTEGER",         "INTEGER");
        m.put("Integer32",       "INTEGER");
        m.put("Unsigned32",      "INTEGER");
        m.put("Integer64",       "LONG");
        m.put("Gauge",           "GAUGE");
        m.put("Gauge32",         "GAUGE32");
        m.put("Counter",         "COUNTER");
        m.put("Counter32",       "COUNTER32");
        m.put("Counter64",       "COUNTER64");
        m.put("TimeTicks",       "TIMETICKS");
        m.put("TimeStamp",       "TIMETICKS");
        m.put("TimeInterval",    "INTEGER");
        // String/binary types
        m.put("OCTET STRING",    "STRING");
        m.put("OCTET_STRING",    "STRING");
        m.put("OctetString",     "STRING");
        m.put("DisplayString",   "STRING");
        m.put("SnmpAdminString", "STRING");
        m.put("PhysAddress",     "STRING");
        m.put("MacAddress",      "STRING");
        m.put("DateAndTime",     "STRING");
        m.put("Bits",            "STRING");
        m.put("BITS",            "STRING");
        // IP types
        m.put("IpAddress",       "IPADDRESS");
        m.put("IPAddress",       "IPADDRESS");
        m.put("InetAddress",     "IPADDRESS");
        m.put("InetAddressIPv4", "IPADDRESS");
        m.put("InetAddressIPv6", "STRING");
        // Boolean
        m.put("TruthValue",      "BOOLEAN");
        // OID
        m.put("OBJECT IDENTIFIER", "OID");
        m.put("ObjectIdentifier",  "OID");
        m.put("AutonomousType",    "OID");
        // Float-ish
        m.put("Float",           "FLOAT");
        m.put("Double",          "FLOAT");
        SYNTAX_TO_NMS = Collections.unmodifiableMap(m);
    }

    // ── Regex patterns ────────────────────────────────────────────────────────

    /** MODULE-IDENTITY declaration — used to find module name. */
    private static final Pattern MODULE_IDENTITY_PAT =
            Pattern.compile("^(\\w+)\\s+MODULE-IDENTITY", Pattern.MULTILINE);

    /** OBJECT-TYPE block open — captures object name. */
    private static final Pattern OBJECT_TYPE_PAT =
            Pattern.compile("^(\\w+)\\s+OBJECT-TYPE\\s*$", Pattern.MULTILINE);

    /** OBJECT IDENTIFIER simple assignment: name OBJECT IDENTIFIER ::= { parent N } */
    private static final Pattern OID_ASSIGNMENT_SIMPLE =
            Pattern.compile("(\\w+)\\s+OBJECT\\s+IDENTIFIER\\s*::=\\s*\\{([^}]+)\\}", Pattern.DOTALL);

    /** Any ::= { ... } assignment (catches MODULE-IDENTITY, OBJECT-TYPE, etc.). */
    private static final Pattern ASSIGNMENT_PAT =
            Pattern.compile("::=\\s*\\{([^}]+)\\}", Pattern.DOTALL);

    /** INDEX { obj1, obj2, ... } */
    private static final Pattern INDEX_PAT =
            Pattern.compile("INDEX\\s*\\{([^}]+)\\}", Pattern.DOTALL | Pattern.CASE_INSENSITIVE);

    /** AUGMENTS { entryObject } — treated as single-index or inherited */
    private static final Pattern AUGMENTS_PAT =
            Pattern.compile("AUGMENTS\\s*\\{([^}]+)\\}", Pattern.DOTALL | Pattern.CASE_INSENSITIVE);

    /** Integer enumeration values: { value1(0), value2(1) } */
    private static final Pattern ENUM_VALUES_PAT =
            Pattern.compile("\\{([^}]+)\\}", Pattern.DOTALL);

    /** Single enum entry: word(digits) */
    private static final Pattern ENUM_ENTRY_PAT =
            Pattern.compile("(\\w+)\\s*\\((\\d+)\\)");

    /** DESCRIPTION "..." — possibly multi-line; only capture first sentence */
    private static final Pattern DESC_PAT =
            Pattern.compile("DESCRIPTION\\s+\"([^\"]*?)\"", Pattern.DOTALL | Pattern.CASE_INSENSITIVE);

    /** MAX-ACCESS value */
    private static final Pattern ACCESS_PAT =
            Pattern.compile("MAX-ACCESS\\s+(\\S+)", Pattern.CASE_INSENSITIVE);

    /** STATUS value */
    private static final Pattern STATUS_PAT =
            Pattern.compile("STATUS\\s+(\\S+)", Pattern.CASE_INSENSITIVE);

    /** UNITS "value" */
    private static final Pattern UNITS_PAT =
            Pattern.compile("UNITS\\s+\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Parses a MIB file and returns the classified, OID-resolved object list
     * together with statistics.
     *
     * @param bytes    raw bytes of the MIB text file
     * @param filename original filename (used for logging only)
     * @return parsed result with objects, statistics, and generated XML
     */
    public ParsedMibResult parse(byte[] bytes, String filename) {
        String raw = new String(bytes, StandardCharsets.UTF_8);
        String content = stripComments(raw);

        List<String> warnings = new ArrayList<>();

        // Step 1: find module name
        String moduleName = extractModuleName(content);

        // Step 2: build OID resolution map
        Map<String, String> oidMap = buildOidMap(content, warnings);

        // Step 3: extract all OBJECT-TYPE raw blocks
        List<RawEntry> rawEntries = extractObjectTypeBlocks(content, warnings);

        // Step 4: resolve OIDs for every entry
        for (RawEntry e : rawEntries) {
            e.resolvedOid = resolveOid(e.name, e.parentName, e.childIndex, oidMap, warnings);
        }

        // Step 5: build entry-index map (entryName → list of index object names)
        Map<String, List<String>> entryIndexMap = buildEntryIndexMap(rawEntries);

        // Step 6: build parent→entry mapping (which columns belong to which entry)
        //         An object is a table column if its parent is a table entry.
        Map<String, String> parentToEntry = buildParentToEntryMap(rawEntries);

        // Step 7: classify objects + map types
        List<MibObject> objects = new ArrayList<>();
        for (RawEntry e : rawEntries) {
            if (e.isTable) continue; // SEQUENCE OF → skip
            if (e.isEntry) continue; // not-accessible table entry → skip
            // Skip not-accessible non-entry objects (e.g. conceptual row objects)
            if ("not-accessible".equalsIgnoreCase(e.access)) continue;
            // Skip deprecated / obsolete if access already said not-accessible
            if ("obsolete".equalsIgnoreCase(e.status)) continue;

            // Determine index type from enclosing table entry
            List<String> indexNames = resolveIndexNames(e, rawEntries, entryIndexMap, parentToEntry);
            MibIndexType indexType = MibIndexType.fromIndexCount(indexNames.size());
            boolean isColumn = indexNames.size() > 0;

            // Determine NMS data type
            String nmsType = mapSyntaxToNmsType(e.syntax, e.enumValues);

            // Derive section/subSection from OID subtree
            String[] sections = deriveSection(e.name, e.resolvedOid);

            MibObject obj = MibObject.builder()
                    .name(e.name)
                    .oid(e.resolvedOid)
                    .rawSyntax(e.syntax)
                    .nmsDataType(nmsType)
                    .access(e.access)
                    .status(e.status)
                    .description(e.description)
                    .units(e.units)
                    .indexType(indexType)
                    .indexNames(indexNames)
                    .enumValues(e.enumValues)
                    .tableColumn(isColumn)
                    .parentName(e.parentName)
                    .childIndex(e.childIndex)
                    .section(sections[0])
                    .subSection(sections[1])
                    .build();

            objects.add(obj);
        }

        // Sort by OID for deterministic output
        objects.sort(Comparator.comparing(o -> oidSortKey(o.getOid())));

        // Compute statistics
        long scalars  = objects.stream().filter(o -> o.getIndexType() == MibIndexType.SCALAR).count();
        long single   = objects.stream().filter(o -> o.getIndexType() == MibIndexType.SINGLE_INDEX).count();
        long dbl      = objects.stream().filter(o -> o.getIndexType() == MibIndexType.DOUBLE_INDEX).count();
        long triple   = objects.stream().filter(o -> o.getIndexType() == MibIndexType.TRIPLE_INDEX).count();
        long enums    = objects.stream().filter(o -> "ENUM".equals(o.getNmsDataType())).count();

        // Enterprise OID = common prefix of all objects' OIDs
        String enterpriseOid = deriveEnterpriseOid(oidMap);

        // Vendor / product line from module name
        String vendor = inferVendor(moduleName, enterpriseOid);
        String productLine = inferProductLine(moduleName, filename);

        log.info("MIB parsed: module={} objects={} scalars={} single={} double={} triple={}",
                moduleName, objects.size(), scalars, single, dbl, triple);

        return ParsedMibResult.builder()
                .moduleName(moduleName)
                .enterpriseOid(enterpriseOid)
                .vendor(vendor)
                .productLine(productLine)
                .objects(objects)
                .totalObjects(objects.size())
                .scalarCount((int) scalars)
                .singleIndexCount((int) single)
                .doubleIndexCount((int) dbl)
                .tripleIndexCount((int) triple)
                .enumCount((int) enums)
                .warnings(warnings)
                .build();
    }

    // ── Comment stripping ─────────────────────────────────────────────────────

    /**
     * Removes MIB comments. MIB comments start with {@code --} and run to end of line,
     * OR to the next {@code --} on the same line (inline comment delimiter).
     * String literals ({@code "..."}) are preserved intact.
     */
    private String stripComments(String src) {
        StringBuilder sb = new StringBuilder(src.length());
        boolean inString = false;
        int i = 0;
        while (i < src.length()) {
            char c = src.charAt(i);
            if (c == '"' && !inString) {
                inString = true;
                sb.append(c);
                i++;
            } else if (c == '"' && inString) {
                inString = false;
                sb.append(c);
                i++;
            } else if (!inString && i + 1 < src.length()
                    && c == '-' && src.charAt(i + 1) == '-') {
                // skip to end of line or next --
                i += 2;
                while (i < src.length() && src.charAt(i) != '\n') {
                    // check for closing -- on same line
                    if (i + 1 < src.length() && src.charAt(i) == '-' && src.charAt(i + 1) == '-') {
                        i += 2;
                        break;
                    }
                    i++;
                }
            } else {
                sb.append(c);
                i++;
            }
        }
        return sb.toString();
    }

    // ── Module name extraction ────────────────────────────────────────────────

    private String extractModuleName(String content) {
        Matcher m = MODULE_IDENTITY_PAT.matcher(content);
        if (m.find()) return m.group(1);
        // Fallback: first DEFINITIONS ::= BEGIN
        Pattern def = Pattern.compile("(\\w+)\\s+DEFINITIONS\\s*::=\\s*BEGIN");
        Matcher m2 = def.matcher(content);
        if (m2.find()) return m2.group(1);
        return "UNKNOWN-MIB";
    }

    // ── OID map construction ─────────────────────────────────────────────────

    /**
     * Collects all {@code name ::= { parent N }} assignments and resolves them
     * to numeric OID strings. Uses multiple passes to handle forward references.
     */
    private Map<String, String> buildOidMap(String content, List<String> warnings) {
        Map<String, String> oidMap = new LinkedHashMap<>(WELL_KNOWN);

        // Extract all name ::= { ... } assignments using broad pattern
        // Pattern: word ... ::= { content }
        Pattern assignPat = Pattern.compile(
                "(\\w+)\\s+(?:MODULE-IDENTITY|OBJECT-TYPE|OBJECT\\s+IDENTIFIER|NOTIFICATION-TYPE|" +
                "MODULE-COMPLIANCE|OBJECT-GROUP|NOTIFICATION-GROUP|TEXTUAL-CONVENTION|" +
                "OBJECT-IDENTITY|AGENT-CAPABILITIES|TRAP-TYPE)?[^:]*?::=\\s*\\{([^}]+)\\}",
                Pattern.DOTALL
        );

        // Also catch simple OBJECT IDENTIFIER assignments
        Matcher simpleMatcher = OID_ASSIGNMENT_SIMPLE.matcher(content);
        Map<String, String[]> rawAssignments = new LinkedHashMap<>();
        while (simpleMatcher.find()) {
            String name = simpleMatcher.group(1);
            String body = simpleMatcher.group(2).trim();
            String[] parts = parseOidBody(body);
            if (parts != null) rawAssignments.put(name, parts);
        }

        // General assignment scanner
        Pattern genAssign = Pattern.compile(
                "^(\\w+)\\s+(?:MODULE-IDENTITY|OBJECT\\s+IDENTIFIER)[^:]*::=\\s*\\{([^}]+)\\}",
                Pattern.MULTILINE | Pattern.DOTALL);
        Matcher genMatcher = genAssign.matcher(content);
        while (genMatcher.find()) {
            String name = genMatcher.group(1);
            String body = genMatcher.group(2).trim();
            String[] parts = parseOidBody(body);
            if (parts != null) rawAssignments.putIfAbsent(name, parts);
        }

        // Also scan for OBJECT-TYPE ::= assignments to capture OID tree
        Pattern objTypePat = Pattern.compile(
                "^(\\w+)\\s+OBJECT-TYPE.*?::=\\s*\\{([^}]+)\\}",
                Pattern.MULTILINE | Pattern.DOTALL);
        Matcher objMatcher = objTypePat.matcher(content);
        while (objMatcher.find()) {
            String name = objMatcher.group(1);
            String body = objMatcher.group(2).trim();
            String[] parts = parseOidBody(body);
            if (parts != null) rawAssignments.putIfAbsent(name, parts);
        }

        // Iteratively resolve OIDs (multiple passes to handle forward refs)
        boolean changed = true;
        int iterations = 0;
        while (changed && iterations++ < 20) {
            changed = false;
            for (Map.Entry<String, String[]> e : rawAssignments.entrySet()) {
                String name = e.getKey();
                if (oidMap.containsKey(name)) continue;
                String[] parts = e.getValue();
                // parts[0] = parent name, parts[1] = numeric suffix
                String parentOid = oidMap.get(parts[0]);
                if (parentOid != null) {
                    oidMap.put(name, parentOid + "." + parts[1]);
                    changed = true;
                }
            }
        }

        // Warn about unresolved names
        for (String name : rawAssignments.keySet()) {
            if (!oidMap.containsKey(name)) {
                String parent = rawAssignments.get(name)[0];
                if (!WELL_KNOWN.containsKey(parent)) {
                    warnings.add("Could not resolve OID for '" + name + "' (parent '" + parent + "' not found)");
                }
            }
        }

        return oidMap;
    }

    /**
     * Parses the body of a {@code ::= { ... }} assignment.
     * Handles patterns like: {@code parent 1}, {@code parent child 2}, {@code 1 3 6 1 4 1 N}.
     *
     * @return two-element array [parentName, numericSuffix] or null if unparseable
     */
    private String[] parseOidBody(String body) {
        body = body.trim();
        // Tokenize by whitespace
        String[] tokens = body.split("\\s+");
        if (tokens.length == 0) return null;

        // Case 1: all numeric → absolute OID (e.g. { 1 3 6 1 4 1 52619 })
        if (tokens.length >= 2 && tokens[0].matches("\\d+")) {
            String joined = String.join(".", tokens);
            return new String[]{"__absolute__", joined};
        }

        // Case 2: { parentName N } — most common
        if (tokens.length == 2 && tokens[1].matches("\\d+")) {
            return new String[]{tokens[0], tokens[1]};
        }

        // Case 3: { name1 N1 name2 N2 } — compound, walk the chain
        // Build suffix by concatenating all numeric parts
        StringBuilder suffix = new StringBuilder();
        String lastName = null;
        for (String tok : tokens) {
            if (tok.matches("\\d+")) {
                if (suffix.length() > 0) suffix.append(".");
                suffix.append(tok);
            } else {
                lastName = tok;
                // The last non-numeric token before the final numbers is the parent
            }
        }
        if (lastName != null && suffix.length() > 0) {
            return new String[]{lastName, suffix.toString()};
        }

        // Case 4: single token (unusual) — might be absolute numeric
        if (tokens.length == 1 && tokens[0].matches("\\d+")) {
            return new String[]{"iso", tokens[0]};
        }

        return null;
    }

    // ── OBJECT-TYPE block extraction ─────────────────────────────────────────

    /**
     * Scans the MIB content with a state machine to extract all OBJECT-TYPE blocks.
     * Each block runs from {@code name OBJECT-TYPE} to the matching {@code ::= { ... }}.
     */
    private List<RawEntry> extractObjectTypeBlocks(String content, List<String> warnings) {
        List<RawEntry> entries = new ArrayList<>();
        String[] lines = content.split("\n");
        StringBuilder block = new StringBuilder();
        String currentName = null;
        boolean inBlock = false;
        int braceDepth = 0;
        boolean foundAssignment = false;

        for (String line : lines) {
            String trimmed = line.trim();

            if (!inBlock) {
                // Look for: word OBJECT-TYPE (possibly with trailing whitespace)
                Matcher m = Pattern.compile("^(\\w+)\\s+OBJECT-TYPE\\s*$").matcher(trimmed);
                if (!m.matches()) {
                    // Also try inline: "radioStatus OBJECT-TYPE"
                    m = Pattern.compile("^(\\w+)\\s+OBJECT-TYPE\\s").matcher(trimmed);
                    if (!m.find()) {
                        m = null;
                    }
                }
                if (m != null && m.groupCount() >= 1) {
                    currentName = m.group(1);
                    block.setLength(0);
                    block.append(line).append("\n");
                    inBlock = true;
                    braceDepth = 0;
                    foundAssignment = false;
                }
            } else {
                block.append(line).append("\n");
                // Track brace depth for the ::= { ... } part
                for (char c : line.toCharArray()) {
                    if (c == '{') braceDepth++;
                    if (c == '}') {
                        braceDepth--;
                        if (braceDepth <= 0 && foundAssignment) {
                            // End of block
                            RawEntry entry = parseBlock(currentName, block.toString(), warnings);
                            if (entry != null) entries.add(entry);
                            inBlock = false;
                            currentName = null;
                            block.setLength(0);
                            break;
                        }
                    }
                }
                // Detect ::= start
                if (trimmed.contains("::=")) {
                    foundAssignment = true;
                }
            }
        }
        return entries;
    }

    /** Parses an individual OBJECT-TYPE block string into a {@link RawEntry}. */
    private RawEntry parseBlock(String name, String block, List<String> warnings) {
        RawEntry entry = new RawEntry();
        entry.name = name;

        // ── SYNTAX ──────────────────────────────────────────────────────────
        // SYNTAX may be simple (Integer32) or complex (INTEGER { e1(0), e2(1) })
        // Extract everything between SYNTAX and the next keyword or end of SYNTAX clause
        Pattern syntaxPat = Pattern.compile(
                "SYNTAX\\s+(.*?)(?=\\n\\s*(?:UNITS|MAX-ACCESS|ACCESS|STATUS|DESCRIPTION|REFERENCE|INDEX|AUGMENTS|DEFVAL|::=)|$)",
                Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
        Matcher sm = syntaxPat.matcher(block);
        if (sm.find()) {
            String syntaxRaw = sm.group(1).trim();
            // Check if it contains enum values
            if (syntaxRaw.contains("{") && (syntaxRaw.startsWith("INTEGER") || syntaxRaw.startsWith("BITS"))) {
                // Extract enum values
                Matcher em = ENUM_VALUES_PAT.matcher(syntaxRaw);
                if (em.find()) {
                    String enumBody = em.group(1);
                    Matcher ev = ENUM_ENTRY_PAT.matcher(enumBody);
                    while (ev.find()) {
                        entry.enumValues.put(ev.group(1) + "(" + ev.group(2) + ")", ev.group(2));
                    }
                }
                entry.syntax = "INTEGER";
                if (!entry.enumValues.isEmpty()) entry.isEnum = true;
            } else if (syntaxRaw.startsWith("SEQUENCE OF")) {
                entry.syntax = "SEQUENCE OF";
                entry.isTable = true;
            } else if (syntaxRaw.startsWith("SEQUENCE")) {
                entry.syntax = "SEQUENCE";
                entry.isEntry = true;
            } else {
                // Plain type — take first token (ignore size constraints like OCTET STRING (SIZE ...))
                entry.syntax = syntaxRaw.split("\\s+")[0].trim();
                // Handle "OCTET STRING" (two words)
                if ("OCTET".equals(entry.syntax) && syntaxRaw.startsWith("OCTET STRING")) {
                    entry.syntax = "OCTET STRING";
                }
                // Handle "OBJECT IDENTIFIER"
                if ("OBJECT".equals(entry.syntax) && syntaxRaw.startsWith("OBJECT IDENTIFIER")) {
                    entry.syntax = "OBJECT IDENTIFIER";
                }
            }
        }

        // ── MAX-ACCESS / ACCESS ──────────────────────────────────────────────
        Matcher am = ACCESS_PAT.matcher(block);
        if (am.find()) {
            entry.access = am.group(1).trim().toLowerCase();
        } else {
            // Older SMIv1 uses ACCESS instead of MAX-ACCESS
            Matcher am2 = Pattern.compile("\\bACCESS\\s+(\\S+)", Pattern.CASE_INSENSITIVE).matcher(block);
            if (am2.find()) entry.access = am2.group(1).trim().toLowerCase();
        }

        // ── STATUS ───────────────────────────────────────────────────────────
        Matcher stm = STATUS_PAT.matcher(block);
        if (stm.find()) entry.status = stm.group(1).trim().toLowerCase();

        // ── DESCRIPTION (first sentence only) ────────────────────────────────
        Matcher dm = DESC_PAT.matcher(block);
        if (dm.find()) {
            String desc = dm.group(1).trim().replaceAll("\\s+", " ");
            // Truncate to first sentence
            int dotIdx = desc.indexOf('.');
            entry.description = (dotIdx > 0 && dotIdx < 200) ? desc.substring(0, dotIdx + 1) : desc;
            if (entry.description.length() > 250) entry.description = entry.description.substring(0, 250) + "…";
        }

        // ── UNITS ────────────────────────────────────────────────────────────
        Matcher um = UNITS_PAT.matcher(block);
        if (um.find()) entry.units = um.group(1).trim();

        // ── INDEX { ... } ────────────────────────────────────────────────────
        Matcher im = INDEX_PAT.matcher(block);
        if (im.find()) {
            String indexBody = im.group(1);
            String[] idxTokens = indexBody.split("[,\\s]+");
            for (String tok : idxTokens) {
                tok = tok.trim().replaceAll("^IMPLIED\\s+", "");
                if (!tok.isEmpty() && tok.matches("[a-zA-Z]\\w*")) {
                    entry.indexNames.add(tok);
                }
            }
            entry.isEntry = true; // has INDEX → this is a table entry definition
        }

        // ── AUGMENTS { ... } ─────────────────────────────────────────────────
        Matcher augm = AUGMENTS_PAT.matcher(block);
        if (augm.find()) {
            entry.augmentsEntry = augm.group(1).trim().split("\\s+")[0];
            entry.isEntry = true;
        }

        // ── ::= { parent N } ────────────────────────────────────────────────
        Matcher assm = ASSIGNMENT_PAT.matcher(block);
        if (assm.find()) {
            String body = assm.group(1).trim();
            String[] parts = parseOidBody(body);
            if (parts != null) {
                entry.parentName = parts[0];
                // parts[1] may be compound "1.2.3" — use last segment as childIndex
                String[] nums = parts[1].split("\\.");
                try {
                    entry.childIndex = Integer.parseInt(nums[nums.length - 1]);
                    // For compound suffix, join all
                    entry.oidSuffix = parts[1];
                } catch (NumberFormatException ex) {
                    entry.childIndex = 0;
                }
            }
        }

        return entry;
    }

    // ── Table structure analysis ──────────────────────────────────────────────

    /**
     * Builds a map from table-entry object name → list of INDEX names.
     * Only entries that have an INDEX clause are included.
     */
    private Map<String, List<String>> buildEntryIndexMap(List<RawEntry> entries) {
        Map<String, List<String>> map = new HashMap<>();
        for (RawEntry e : entries) {
            if (e.isEntry && !e.indexNames.isEmpty()) {
                map.put(e.name, List.copyOf(e.indexNames));
            }
        }
        return map;
    }

    /**
     * Builds a map from parent-object-name → table-entry-name.
     * This lets us determine if a column's parent is a table entry.
     */
    private Map<String, String> buildParentToEntryMap(List<RawEntry> entries) {
        // entry name → entry's parent (= the TABLE object)
        Map<String, String> map = new HashMap<>();
        for (RawEntry e : entries) {
            if (e.isEntry) {
                // The entry's parentName is the TABLE object name.
                // Columns have parentName = entry name.
                // So: entryName → entryName (self-reference for lookup)
                map.put(e.name, e.name);
            }
        }
        return map;
    }

    /**
     * Resolves the index names for a given raw entry.
     * Walks up the parent chain: column → entry → gets entry's INDEX.
     */
    private List<String> resolveIndexNames(RawEntry e, List<RawEntry> allEntries,
                                            Map<String, List<String>> entryIndexMap,
                                            Map<String, String> parentToEntry) {
        // If this object itself has an INDEX, it's the entry — columns inherit this
        if (!e.indexNames.isEmpty()) return e.indexNames;

        // Look up parent to see if it's a table entry
        String parentName = e.parentName;
        if (parentName == null) return List.of();

        // Direct parent is an entry with INDEX?
        List<String> idx = entryIndexMap.get(parentName);
        if (idx != null) return idx;

        // Parent is an entry that AUGMENTS another entry?
        RawEntry parent = allEntries.stream()
                .filter(x -> x.name.equals(parentName))
                .findFirst().orElse(null);
        if (parent == null) return List.of();

        if (parent.augmentsEntry != null) {
            List<String> augIdx = entryIndexMap.get(parent.augmentsEntry);
            if (augIdx != null) return augIdx;
        }

        // Check if parent's parent is an entry (grandparent case)
        if (parent.parentName != null) {
            List<String> gpIdx = entryIndexMap.get(parent.parentName);
            if (gpIdx != null) return gpIdx;
        }

        return List.of();
    }

    // ── OID resolution ────────────────────────────────────────────────────────

    private String resolveOid(String name, String parentName, int childIndex,
                               Map<String, String> oidMap, List<String> warnings) {
        if (parentName == null) return null;

        // Special case for absolute OIDs stored in map
        if ("__absolute__".equals(parentName)) {
            return "." + String.valueOf(childIndex);
        }

        String parentOid = oidMap.get(parentName);
        if (parentOid == null) {
            // Try looking up the name itself (might already be resolved)
            String selfOid = oidMap.get(name);
            if (selfOid != null) return "." + selfOid;
            warnings.add("Unresolved OID for '" + name + "' — parent '" + parentName + "' not found");
            return null;
        }

        // Normalize: ensure starts with dot
        String base = parentOid.startsWith(".") ? parentOid : "." + parentOid;
        return base + "." + childIndex;
    }

    // ── Type mapping ──────────────────────────────────────────────────────────

    private String mapSyntaxToNmsType(String syntax, Map<String, String> enumValues) {
        if (syntax == null) return "STRING";
        if (!enumValues.isEmpty()) return "ENUM";

        // Direct lookup
        String mapped = SYNTAX_TO_NMS.get(syntax);
        if (mapped != null) return mapped;

        // Case-insensitive fallback
        for (Map.Entry<String, String> entry : SYNTAX_TO_NMS.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(syntax)) return entry.getValue();
        }

        // Heuristics for common patterns
        String lower = syntax.toLowerCase();
        if (lower.contains("counter64"))   return "COUNTER64";
        if (lower.contains("counter32"))   return "COUNTER32";
        if (lower.contains("counter"))     return "COUNTER";
        if (lower.contains("gauge32"))     return "GAUGE32";
        if (lower.contains("gauge"))       return "GAUGE";
        if (lower.contains("timetick"))    return "TIMETICKS";
        if (lower.contains("integer"))     return "INTEGER";
        if (lower.contains("unsigned"))    return "INTEGER";
        if (lower.contains("ipaddress") || lower.contains("inetaddress")) return "IPADDRESS";
        if (lower.contains("string") || lower.contains("display") || lower.contains("octet")) return "STRING";
        if (lower.contains("macaddress") || lower.contains("physaddress")) return "STRING";
        if (lower.contains("truthvalue")) return "BOOLEAN";
        if (lower.contains("oid") || lower.contains("identifier")) return "OID";
        if (lower.contains("float") || lower.contains("double")) return "FLOAT";

        // Default: treat unknown types as STRING (most MIB types are string-derived)
        return "STRING";
    }

    // ── Section/subSection derivation ────────────────────────────────────────

    /**
     * Derives section and subSection names from the object's OID subtree.
     *
     * <p>For wireless enterprise MIBs the typical structure after the enterprise OID is:
     * <pre>
     *   .enterprise.1.*  → configuration
     *   .enterprise.2.*  → management
     *   .enterprise.3.*  → monitor / statistics
     *   .enterprise.4.*  → network
     * </pre>
     * The exact mapping is inferred from the object name using keyword matching.
     */
    private String[] deriveSection(String name, String oid) {
        String lower = name.toLowerCase();

        // Section inference from name keywords
        String section;
        if (lower.contains("monitor") || lower.contains("stat") || lower.contains("counter")
                || lower.contains("linkstat") || lower.contains("wireless_stat")
                || lower.contains("throughput") || lower.contains("rssi")
                || lower.contains("snr") || lower.contains("noise")) {
            section = "monitor";
        } else if (lower.contains("mgmt") || lower.contains("manage") || lower.contains("trap")
                || lower.contains("syslog") || lower.contains("ntp") || lower.contains("snmp")
                || lower.contains("sysname") || lower.contains("contact")
                || lower.contains("location")) {
            section = "management";
        } else if (lower.contains("network") || lower.contains("ip") || lower.contains("vlan")
                || lower.contains("route") || lower.contains("bridge") || lower.contains("dhcp")) {
            section = "network";
        } else {
            section = "configuration";
        }

        // SubSection from OID position (4th segment after enterprise = group)
        String subSection = inferSubSectionFromName(name, section);

        return new String[]{section, subSection};
    }

    private String inferSubSectionFromName(String name, String section) {
        String lower = name.toLowerCase();
        if (lower.contains("radio") || lower.contains("wireless") || lower.contains("rf")) {
            return section + ".radio";
        }
        if (lower.contains("link")) {
            return section + ".link";
        }
        if (lower.contains("ip") || lower.contains("addr") || lower.contains("subnet")) {
            return section + ".ip";
        }
        if (lower.contains("vlan")) return section + ".vlan";
        if (lower.contains("qos"))  return section + ".qos";
        if (lower.contains("acl") || lower.contains("security")) return section + ".security";
        return section;
    }

    // ── Utility helpers ───────────────────────────────────────────────────────

    /** Produces a sort key from a numeric OID string for lexicographic OID ordering. */
    private String oidSortKey(String oid) {
        if (oid == null) return "";
        return Arrays.stream(oid.replace(".", " ").trim().split("\\s+"))
                .map(s -> {
                    try { return String.format("%010d", Integer.parseInt(s)); }
                    catch (NumberFormatException e) { return s; }
                })
                .collect(Collectors.joining("."));
    }

    /** Finds the enterprise OID from the OID map (first non-IETF arc under enterprises). */
    private String deriveEnterpriseOid(Map<String, String> oidMap) {
        String enterprisesOid = "1.3.6.1.4.1";
        // Find the first OID that is exactly one hop below enterprises
        return oidMap.values().stream()
                .filter(o -> {
                    String normalized = o.startsWith(".") ? o.substring(1) : o;
                    if (!normalized.startsWith(enterprisesOid + ".")) return false;
                    String remaining = normalized.substring(enterprisesOid.length() + 1);
                    return !remaining.contains("."); // exactly one segment after enterprises
                })
                .map(o -> o.startsWith(".") ? o : "." + o)
                .findFirst()
                .orElse(".1.3.6.1.4.1");
    }

    private String inferVendor(String moduleName, String enterpriseOid) {
        // Strip common MIB suffixes from module name
        String v = moduleName
                .replaceAll("(?i)-MIB$", "")
                .replaceAll("(?i)-PRIVATE$", "")
                .replaceAll("(?i)-ENTERPRISE$", "")
                .replaceAll("(?i)-SMI$", "")
                .replace("_", " ");
        // Take up to first hyphen or first word
        String[] parts = v.split("-");
        return parts[0].trim().isEmpty() ? "Unknown" : parts[0].trim();
    }

    private String inferProductLine(String moduleName, String filename) {
        // Try filename first (sans extension)
        if (filename != null && !filename.isBlank()) {
            String fn = filename.replaceAll("\\.[^.]+$", "").replaceAll("[_-]+", " ").trim();
            if (!fn.isEmpty()) return fn;
        }
        return moduleName.replaceAll("(?i)-MIB$", "").replace("_", " ").trim();
    }

    // ── Inner: raw parsed block ───────────────────────────────────────────────

    /** Intermediate parsed state for one OBJECT-TYPE block. */
    static class RawEntry {
        String name;
        String syntax;
        String access;
        String status;
        String description;
        String units;
        List<String> indexNames = new ArrayList<>();
        Map<String, String> enumValues = new LinkedHashMap<>();
        String parentName;
        int childIndex;
        String oidSuffix;       // may be compound, e.g. "1.2"
        String resolvedOid;
        boolean isTable;        // SEQUENCE OF X
        boolean isEntry;        // has INDEX or is SEQUENCE (row definition)
        boolean isEnum;
        String augmentsEntry;   // for AUGMENTS { entryName }
    }
}
