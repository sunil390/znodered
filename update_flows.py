import json

# Read the latest function code
with open('radar-tracker-v2.js', 'r') as f:
    new_code = f.read()

# Read flows.json
with open('flows.json', 'r') as f:
    flows = json.load(f)

# Find the function node and update its code
found = False
for node in flows:
    if node.get('id') == 'f6fa7c91edf99328' and node.get('type') == 'function':
        print("Found node:", node["name"])
        print("Old code length:", len(node["func"]))
        node['func'] = new_code
        print("New code length:", len(node["func"]))
        found = True
        break

if not found:
    print("ERROR: Function node not found!")
else:
    with open('flows.json', 'w') as f:
        json.dump(flows, f, indent=4)
    print("flows.json updated successfully")
